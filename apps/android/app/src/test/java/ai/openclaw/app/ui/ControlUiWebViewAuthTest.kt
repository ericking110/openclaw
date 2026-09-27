package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthPayload
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.NativeControlUiCredential
import ai.openclaw.app.gateway.buildNativeControlUiConnectAuth
import android.content.Context
import android.net.Uri
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.webkit.JavaScriptExecutionException
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewOutcomeReceiver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  instrumentedPackages = ["androidx.webkit"],
  shadows = [ControlUiAuthFeatureShadow::class, ControlUiAuthCompatShadow::class],
)
class ControlUiWebViewAuthTest {
  @After
  fun resetPlatformBridge() {
    ControlUiAuthCompatShadow.registrations.clear()
    ControlUiAuthCompatShadow.scripts.clear()
    ControlUiAuthFeatureShadow.supported = true
  }

  @Test
  fun mountedBridgeSignsNativeIdentityAndCurrentTokenWithoutExportingStartupSecrets() {
    val app = RuntimeEnvironment.getApplication()
    val storage = app.getSharedPreferences("native-control-auth-test", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    val identityStore = DeviceIdentityStore.withPrefs(app, prefs)
    val identity = identityStore.loadOrCreate()
    val tokens = DeviceAuthStore(prefs)
    val scopes = listOf("operator.read")
    val client = GatewayClientInfo("openclaw-android", null, "test-version", "android", "ui", "native-instance", "Android", null)
    tokens.saveToken("gateway", identity.deviceId, "operator", "first-device-token", scopes)
    val mounted =
      mount { nonce, signedAt ->
        buildNativeControlUiConnectAuth(identityStore, client, scopes, NativeControlUiCredential.DeviceToken(requireNotNull(tokens.loadToken("gateway", identity.deviceId, "operator"))), nonce, signedAt)
      }
    try {
      val script = ControlUiAuthCompatShadow.scripts.getValue(mounted.view)
      assertTrue(script.contains("\"nativeConnectAuth\":true"))
      assertTrue(script.contains("\"token\":null"))
      assertFalse(script.contains("first-device-token"))
      assertFalse(script.contains(identity.privateKeyPkcs8Base64))
      assertEquals(setOf("https://gateway.example:8443"), mounted.registration.origins)
      for (token in listOf("first-device-token", "rotated-device-token")) {
        tokens.saveToken("gateway", identity.deviceId, "operator", token, scopes)
        val result = mounted.request().getValue("result").jsonObject
        assertEquals(
          token,
          result
            .getValue("auth")
            .jsonObject
            .getValue("deviceToken")
            .jsonPrimitive.content,
        )
        assertEquals(scopes, result.getValue("scopes").jsonArray.map { it.jsonPrimitive.content })
        val device = result.getValue("device").jsonObject
        assertEquals(identity.deviceId, device.getValue("id").jsonPrimitive.content)
        assertEquals(identityStore.publicKeyBase64Url(identity), device.getValue("publicKey").jsonPrimitive.content)
        val payload = DeviceAuthPayload.buildV3(identity.deviceId, client.id, client.mode, "operator", scopes, 1700000000123, token, "challenge", client.platform, client.deviceFamily)
        assertTrue(identityStore.verifySelfSignature(payload, device.getValue("signature").jsonPrimitive.content, identity))
        assertEquals(
          "test-version",
          result
            .getValue("client")
            .jsonObject
            .getValue("version")
            .jsonPrimitive.content,
        )
        assertFalse(result.toString().contains(identity.privateKeyPkcs8Base64))
      }
    } finally {
      mounted.close()
      storage.edit().clear().commit()
    }
  }

  @Test
  fun explicitDefaultPortAcceptsBrowserCanonicalOriginWithoutTrustingOtherOrigins() {
    var signed = 0
    val mounted =
      mount(baseUrl = "https://gateway.example:443/openclaw/") { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      assertEquals(setOf("https://gateway.example:443"), mounted.registration.origins)
      mounted.view.loadUrl("https://gateway.example/openclaw/dashboard")
      assertTrue(mounted.request(origin = "https://gateway.example").containsKey("result"))
      assertEquals(1, signed)
      assertNull(mounted.deliver(origin = "https://gateway.example:444"))
      assertNull(mounted.deliver(origin = "http://gateway.example"))
      assertEquals(1, signed)
    } finally {
      mounted.close()
    }
  }

  @Test
  fun cancelledExternalNavigationKeepsCurrentDocumentBridgeAvailable() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      val originalUrl = mounted.view.url
      for (destination in listOf("https://foreign.example/", "https://gateway.example:8443/other/")) {
        assertTrue(mounted.view.webViewClient.shouldOverrideUrlLoading(mounted.view, navigationRequest(destination)))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(originalUrl, mounted.view.url)
        assertTrue(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
        assertTrue(mounted.request().containsKey("result"))
      }
      assertEquals(2, signed)
    } finally {
      mounted.close()
    }
  }

  @Test
  fun mountedBridgeRefusesForeignFramesMalformedRequestsAndRetiredDocuments() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      assertNull(mounted.deliver(origin = "https://foreign.example"))
      assertNull(mounted.deliver(mainFrame = false))
      assertNull(mounted.deliver(data = "not json"))
      for (extra in listOf("\"scopes\":[\"operator.admin\"]", "\"role\":\"node\"", "\"token\":\"chosen\"", "\"payload\":\"arbitrary\"")) {
        val response = mounted.request(data = """{"id":"request","nonce":"challenge","signedAt":1700000000123,$extra}""")
        assertTrue(response.containsKey("error"))
      }
      assertEquals(0, signed)
      mounted.request()
      assertEquals(1, signed)
      // A redirect outside the native route retires even a previously captured listener.
      mounted.view.webViewClient.onPageStarted(mounted.view, "https://gateway.example:8443/other/", null)
      assertNull(mounted.deliver())
      assertEquals(1, signed)
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
    } finally {
      mounted.close()
    }
    assertNull(mounted.deliver())
    assertEquals(1, signed)
  }

  @Test
  fun sameOriginReloadRetiresOldDocumentBridge() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      val client = mounted.view.webViewClient
      client.onPageStarted(mounted.view, "https://gateway.example:8443/openclaw/dashboard", null)
      mounted.request()
      client.onPageStarted(mounted.view, "https://gateway.example:8443/openclaw/terminal", null)
      assertNull(mounted.deliver())
      assertEquals(1, signed)
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
      client.shouldOverrideUrlLoading(
        mounted.view,
        navigationRequest("https://gateway.example:8443/openclaw/stale-dashboard"),
      )
      shadowOf(Looper.getMainLooper()).idle()
      val replacement =
        requireNotNull(
          findWebView(
            mounted.controller
              .get()
              .window.decorView,
          ),
        )
      assertTrue(replacement !== mounted.view)
      assertEquals("https://gateway.example:8443/openclaw/terminal", replacement.url)
      assertTrue(ControlUiAuthCompatShadow.registrations.containsKey(replacement))
    } finally {
      mounted.close()
    }
  }

  @Test
  @Suppress("DEPRECATION") // Android only exposes this abstract platform callback as a test fixture.
  fun rendererLossRetiresCapturedBridgeAndUnsupportedWebViewDoesNotLoadGateway() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      mounted.view.webViewClient.onRenderProcessGone(
        mounted.view,
        object : RenderProcessGoneDetail() {
          override fun didCrash(): Boolean = true

          override fun rendererPriorityAtExit(): Int = WebView.RENDERER_PRIORITY_IMPORTANT
        },
      )
      assertNull(mounted.deliver())
      assertEquals(0, signed)
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
    } finally {
      mounted.close()
    }
    ControlUiAuthFeatureShadow.supported = false
    val unsupported = mount { _, _ -> error("No fallback signer") }
    try {
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(unsupported.view))
      assertFalse(
        unsupported.view.url
          .orEmpty()
          .startsWith("https://gateway.example"),
      )
      assertTrue(shadowOf(unsupported.view).lastLoadData.data.contains("Update Android System WebView"))
    } finally {
      unsupported.close()
    }
  }

  private fun navigationRequest(url: String): WebResourceRequest =
    object : WebResourceRequest {
      override fun getUrl(): Uri = Uri.parse(url)

      override fun isForMainFrame(): Boolean = true

      override fun isRedirect(): Boolean = false

      override fun hasGesture(): Boolean = true

      override fun getMethod(): String = "GET"

      override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

  private fun mount(
    baseUrl: String = "https://gateway.example:8443/openclaw/",
    sign: (String, Long) -> JsonObject,
  ): Mounted {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val page = NodeRuntime.GatewayControlPage(baseUrl, null, sign)
    controller.get().setContent {
      OpenClawTheme(themeMode = AppearanceThemeMode.System) {
        ControlUiWebView(page, "${page.baseUrl}dashboard")
      }
    }
    shadowOf(Looper.getMainLooper()).idle()
    return Mounted(controller, requireNotNull(findWebView(controller.get().window.decorView)))
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    return (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
  }

  private class Mounted(
    val controller: org.robolectric.android.controller.ActivityController<ComponentActivity>,
    val view: WebView,
  ) {
    val registration =
      ControlUiAuthCompatShadow.registrations[view]
        ?: ControlUiAuthRegistration(emptySet()) { _, _, _, _, _ -> error("Bridge unavailable") }

    fun request(
      data: String = REQUEST,
      origin: String = "https://gateway.example:8443",
    ): JsonObject = Json.parseToJsonElement(requireNotNull(deliver(data = data, origin = origin))).jsonObject

    fun deliver(
      origin: String = "https://gateway.example:8443",
      mainFrame: Boolean = true,
      data: String = REQUEST,
    ): String? {
      var response: String? = null
      registration.listener.onPostMessage(
        view,
        WebMessageCompat(data),
        Uri.parse(origin),
        mainFrame,
        object : JavaScriptReplyProxy() {
          override fun postMessage(message: String) {
            response = message
          }

          override fun postMessage(message: ByteArray) {
            error("Unexpected binary reply")
          }

          override fun executeJavaScript(
            script: String,
            receiver: WebViewOutcomeReceiver<String, JavaScriptExecutionException>?,
          ) {
            error("Unexpected script reply")
          }
        },
      )
      return response
    }

    fun close() {
      controller.pause().stop().destroy()
      shadowOf(Looper.getMainLooper()).idle()
    }
  }

  companion object {
    private const val REQUEST = """{"id":"request","nonce":"challenge","signedAt":1700000000123}"""
  }
}

internal data class ControlUiAuthRegistration(
  val origins: Set<String>,
  val listener: WebViewCompat.WebMessageListener,
)

@Implements(value = WebViewFeature::class, isInAndroidSdk = false)
class ControlUiAuthFeatureShadow {
  companion object {
    var supported = true

    @JvmStatic
    @Implementation
    fun isFeatureSupported(feature: String): Boolean = supported && feature in setOf(WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)
  }
}

// Only AndroidX's absent platform bridge is replaced: the mounted WebView, registered
// callback, native Ed25519 identity/token store, and lifecycle callbacks are real.
@Implements(value = WebViewCompat::class, isInAndroidSdk = false)
class ControlUiAuthCompatShadow {
  companion object {
    internal val registrations = mutableMapOf<WebView, ControlUiAuthRegistration>()
    internal val scripts = mutableMapOf<WebView, String>()

    @JvmStatic
    @Implementation
    fun addWebMessageListener(
      view: WebView,
      name: String,
      origins: Set<String>,
      listener: WebViewCompat.WebMessageListener,
    ) {
      assertEquals("OpenClawNativeGatewayAuth", name)
      registrations[view] = ControlUiAuthRegistration(origins, listener)
    }

    @JvmStatic
    @Implementation
    fun removeWebMessageListener(
      view: WebView,
      name: String,
    ) {
      registrations.remove(view)
    }

    @JvmStatic
    @Implementation
    fun addDocumentStartJavaScript(
      view: WebView,
      script: String,
      origins: Set<String>,
    ): ScriptHandler {
      scripts[view] = script
      return ScriptHandler { scripts.remove(view) }
    }
  }
}

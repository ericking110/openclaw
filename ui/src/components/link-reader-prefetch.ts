import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { composedParent } from "../lib/navigation-click.ts";
import { linkReaderHovercardBootstrap as bootstrap } from "./link-reader-hovercard-registration.ts";
import { prefetchLinkReader, previewTargetForAnchor } from "./link-reader-prefetch-request.ts";
import {
  LINK_READER_HOVERCARD_PROVIDER_TAG,
  linkReaderTargetKey,
  type HoverPreviewOwner,
} from "./link-reader-target.ts";

const PREFETCH_LIMIT = 8;
const PREFETCH_DELAY_MS = 150;

class LinkReaderPrefetchDirective extends AsyncDirective {
  private root: HTMLElement | undefined;
  private provider: Element | null = null;
  private readonly handleCapabilities = () => {
    this.release();
    this.attempted.clear();
    this.scheduleScan();
  };
  private sessionKey: string | undefined;
  private active = false;
  private scanPending = false;
  private observer: IntersectionObserver | null = null;
  private mutations: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scope = new AbortController();
  private pendingKey: string | undefined;
  private readonly observed = new Map<HTMLAnchorElement, { key: string; visible: boolean }>();
  private readonly attempted = new Set<string>();
  private classifications = new WeakMap<
    HTMLAnchorElement,
    {
      href: string;
      readers: HoverPreviewOwner["readers"] | undefined;
      key: string | null;
    }
  >();
  private ancestors: { element: Element; classes: string | null }[] = [];

  render(_sessionKey: string, _active = true, _connected = true) {
    return nothing;
  }

  override update(
    part: ElementPart,
    [sessionKey, active = true, connected = true]: [string, boolean?, boolean?],
  ) {
    if (sessionKey !== this.sessionKey || !connected) {
      this.release();
      this.attempted.clear();
      this.sessionKey = sessionKey;
    }
    this.root = part.element instanceof HTMLElement ? part.element : undefined;
    const provider = this.root?.closest(LINK_READER_HOVERCARD_PROVIDER_TAG) ?? null;
    if (provider !== this.provider) {
      this.provider?.removeEventListener(
        "link-reader-capabilities-changed",
        this.handleCapabilities,
      );
      this.provider = provider;
      this.provider?.addEventListener("link-reader-capabilities-changed", this.handleCapabilities);
      this.release();
      this.attempted.clear();
    }
    this.active = active && connected;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.handleVisibilityChange();
    return nothing;
  }

  protected override disconnected(): void {
    this.provider?.removeEventListener("link-reader-capabilities-changed", this.handleCapabilities);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.release();
  }

  protected override reconnected(): void {
    this.provider?.addEventListener("link-reader-capabilities-changed", this.handleCapabilities);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.handleVisibilityChange();
  }

  private readonly handleVisibilityChange = () => {
    if (this.active && !document.hidden) {
      this.scheduleScan();
    } else {
      this.release();
    }
  };

  private release(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.mutations?.disconnect();
    this.mutations = null;
    this.observed.clear();
    this.classifications = new WeakMap();
    this.ancestors = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    this.scope.abort();
    this.scope = new AbortController();
    if (this.pendingKey) {
      this.attempted.delete(this.pendingKey);
    }
    this.pendingKey = undefined;
  }

  private canPrefetch(): boolean {
    return this.active && this.isConnected && Boolean(this.root?.isConnected) && !document.hidden;
  }

  private scheduleScan(): void {
    if (this.scanPending) {
      return;
    }
    this.scanPending = true;
    // Lit commits an element directive before its children; virtualized rows can
    // also change without updating this directive.
    queueMicrotask(() => {
      this.scanPending = false;
      if (this.canPrefetch() && this.attempted.size < PREFETCH_LIMIT) {
        this.scan();
      }
    });
  }

  private scan(): void {
    const root = this.root;
    // No eager fallback: lack of visibility observation must not fetch a transcript.
    if (!root || typeof IntersectionObserver === "undefined") {
      return;
    }
    if (!this.observer) {
      const observer = new IntersectionObserver((entries) => {
        if (this.observer !== observer || !this.canPrefetch()) {
          return;
        }
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLAnchorElement)) {
            continue;
          }
          const candidate = this.observed.get(entry.target);
          if (candidate) {
            candidate.visible = entry.isIntersecting;
          }
        }
        this.schedulePrefetch();
      });
      this.observer = observer;
      this.mutations = new MutationObserver((records) => {
        this.invalidateClassifications(records);
        this.scheduleScan();
      });
      this.mutations.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "href",
          "class",
          "download",
          "data-file-path",
          "data-session-href",
          "data-link-reader-external",
          "slot",
        ],
      });
    }
    // A Lit update can queue this scan before mutation delivery. Consume those
    // records first so moved links never reuse their former container's gate.
    this.invalidateClassifications(this.mutations?.takeRecords() ?? []);
    const ancestors: typeof this.ancestors = [];
    for (let element: Element | null = root; element; element = composedParent(element)) {
      ancestors.push({ element, classes: element.getAttribute("class") });
    }
    // Exclusions above the observed root can change between transcript scans.
    if (
      ancestors.length !== this.ancestors.length ||
      ancestors.some(
        ({ element, classes }, index) =>
          element !== this.ancestors[index]?.element || classes !== this.ancestors[index]?.classes,
      )
    ) {
      this.classifications = new WeakMap();
    }
    this.ancestors = ancestors;
    for (const anchor of this.observed.keys()) {
      if (!root.contains(anchor) || !anchor.hasAttribute("href")) {
        this.observer.unobserve(anchor);
        this.observed.delete(anchor);
      }
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      // Nearest-provider lookup preserves nested ownership; reader identity also
      // invalidates negative claims when a nested provider's capabilities change.
      const provider = bootstrap.providerFor(anchor);
      const readers = provider?.client ? provider.readers : undefined;
      const href = anchor.href;
      let classification = this.classifications.get(anchor);
      if (!classification || classification.href !== href || classification.readers !== readers) {
        const target = previewTargetForAnchor(anchor, provider);
        classification = { href, readers, key: target ? linkReaderTargetKey(target) : null };
        this.classifications.set(anchor, classification);
      }
      const { key } = classification;
      const observed = this.observed.get(anchor);
      if (observed && observed.key !== key) {
        this.observer.unobserve(anchor);
        this.observed.delete(anchor);
      }
      if (key && !this.observed.has(anchor) && !this.attempted.has(key)) {
        this.observed.set(anchor, { key, visible: false });
        this.observer.observe(anchor);
      }
    }
  }

  private invalidateClassifications(records: MutationRecord[]): void {
    for (const record of records) {
      const nodes =
        record.type === "attributes"
          ? [record.target]
          : [...record.addedNodes, ...record.removedNodes];
      for (const node of nodes) {
        if (node instanceof HTMLAnchorElement) {
          this.classifications.delete(node);
        }
        if (node instanceof Element) {
          for (const anchor of node.querySelectorAll<HTMLAnchorElement>("a[href]")) {
            this.classifications.delete(anchor);
          }
        }
      }
    }
  }

  private schedulePrefetch(): void {
    if (
      this.timer !== undefined ||
      this.pendingKey !== undefined ||
      !this.canPrefetch() ||
      this.attempted.size >= PREFETCH_LIMIT
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.prefetchNext();
    }, PREFETCH_DELAY_MS);
  }

  private async prefetchNext(): Promise<void> {
    if (!this.canPrefetch()) {
      return;
    }
    // Select distinct previews from current visibility, not a capped anchor queue:
    // repeated links must not crowd out other items or retain an offscreen slot.
    for (const [anchor, { key, visible }] of this.observed) {
      if (!visible || !this.root?.contains(anchor) || this.attempted.has(key)) {
        continue;
      }
      this.attempted.add(key);
      const scope = this.scope;
      this.pendingKey = key;
      try {
        await prefetchLinkReader(anchor, scope.signal);
      } catch {
        // Hover still presents cached errors; speculative work never opens UI.
      } finally {
        if (scope === this.scope) {
          this.pendingKey = undefined;
          if (this.attempted.size >= PREFETCH_LIMIT) {
            this.release();
          } else {
            this.schedulePrefetch();
          }
        }
      }
      return;
    }
  }
}

export const linkReaderPrefetch = directive(LinkReaderPrefetchDirective);

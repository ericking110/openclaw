/* @vitest-environment jsdom */
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installTestLinkReader, TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { prefetchLinkReader } from "./link-reader-prefetch-request.ts";
import { linkReaderPrefetch } from "./link-reader-prefetch.ts";
import * as linkTargets from "./link-reader-target.ts";

vi.mock("./link-reader-prefetch-request.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./link-reader-prefetch-request.ts")>()),
  prefetchLinkReader: vi.fn().mockResolvedValue(undefined),
}));

class VisibilityObserver {
  static instances: VisibilityObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    VisibilityObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  intersect(targets: Element[], isIntersecting = true) {
    this.callback(
      targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

const href = (number: number) => `https://github.com/openclaw/openclaw/issues/${number}`;
let container: HTMLDivElement;
let provider: HTMLElement;

async function show(links = [href(1)], session = "first", active = true, connected = true) {
  render(
    html`<div ${linkReaderPrefetch(session, active, connected)}>
      ${links.map((url) => html`<a class="markdown-github-link" href=${url}>Item</a>`)}
    </div>`,
    container,
  );
  await vi.advanceTimersByTimeAsync(0);
  return [...container.querySelectorAll("a")];
}

function observer() {
  return VisibilityObserver.instances.at(-1)!;
}

const prefetch = vi.mocked(prefetchLinkReader);

describe("GitHub preview warming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", VisibilityObserver);
    VisibilityObserver.instances = [];
    prefetch.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    provider = installTestLinkReader(
      document.createElement(linkTargets.LINK_READER_HOVERCARD_PROVIDER_TAG),
    );
    provider.append(container);
    document.body.append(provider);
  });

  afterEach(() => {
    render(nothing, container);
    provider.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skips exclusion walks for links without a preview-capable reader", async () => {
    const gate = vi.spyOn(linkTargets, "isPreviewAnchor");
    await show(["https://example.com/page"]);
    Object.assign(provider, {
      readers: [
        {
          ...TEST_LINK_READER,
          linkReader: { ...TEST_LINK_READER.linkReader, previewMethod: undefined },
        },
      ],
    });
    await show([href(1)]);
    expect(gate).not.toHaveBeenCalled();
    expect(observer().targets.size).toBe(0);
  });

  it("reuses unchanged positive and negative classifications after unrelated mutations", async () => {
    const gate = vi.spyOn(linkTargets, "isPreviewAnchor");
    const resolve = vi.spyOn(linkTargets, "resolveLinkReaderTarget");
    const links = await show([href(1), "https://example.com/page", href(2)]);
    links[2]!.download = "item";
    await vi.advanceTimersByTimeAsync(0);
    gate.mockClear();
    resolve.mockClear();

    container.firstElementChild!.append(document.createTextNode("streaming delta"));
    await vi.advanceTimersByTimeAsync(0);
    expect(gate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect([...observer().targets]).toEqual([links[0]]);

    links[1]!.href = href(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.mock.calls.map(([anchor]) => anchor)).toEqual([links[1]]);
    observer().intersect(links);
    await vi.advanceTimersByTimeAsync(500);
    expect(prefetch.mock.calls.map(([anchor]) => anchor)).toEqual([links[0], links[1]]);
  });

  it.each([
    ["download", ""],
    ["data-file-path", "/tmp/file"],
    ["data-session-href", "session"],
    ["class", "markdown-session-link"],
    ["data-link-reader-external", ""],
  ])("reclassifies the %s exclusion without changing href", async (attribute, value) => {
    await show([]);
    const link = document.createElement("a");
    link.href = href(1);
    link.setAttribute(attribute, value);
    container.firstElementChild!.append(link);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.size).toBe(0);
    link.removeAttribute(attribute);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.has(link)).toBe(true);
    observer().intersect([link]);
    link.setAttribute(attribute, value);
    await vi.advanceTimersByTimeAsync(500);
    expect(observer().targets.size).toBe(0);
    expect(prefetch).not.toHaveBeenCalled();
    link!.removeAttribute(attribute);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.has(link!)).toBe(true);
    observer().intersect([link!]);
    await vi.advanceTimersByTimeAsync(200);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["openclaw-tooltip", ""],
    ["openclaw-browser-tab-card", ""],
    ["wa-popover", ""],
    ["div", "link-reader-hovercard"],
    ["div", "link-hovercard"],
    ["div", "session-progress-hovercard"],
    ["div", "chat-source-card"],
  ])("reclassifies links moved into and out of %s.%s", async (tag, className) => {
    const [link] = await show();
    const root = container.firstElementChild!;
    const excluded = document.createElement(tag);
    excluded.className = className;
    root.append(excluded);
    observer().intersect([link!]);
    excluded.append(link!);
    await vi.advanceTimersByTimeAsync(500);
    expect(observer().targets.size).toBe(0);
    expect(prefetch).not.toHaveBeenCalled();
    root.append(link!);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.has(link!)).toBe(true);
  });

  it.each(["inside", "outside"])(
    "invalidates changed ancestor exclusions %s the root",
    async (where) => {
      const [link] = await show();
      const ancestor = where === "inside" ? container.firstElementChild! : container;
      ancestor.classList.add("chat-source-card");
      // Outside-root changes were discovered by the next transcript scan.
      container.firstElementChild!.append(document.createTextNode("delta"));
      await vi.advanceTimersByTimeAsync(0);
      expect(observer().targets.size).toBe(0);
      ancestor.classList.remove("chat-source-card");
      container.firstElementChild!.append(document.createTextNode("delta"));
      await vi.advanceTimersByTimeAsync(0);
      expect(observer().targets.has(link!)).toBe(true);
    },
  );

  it("keeps ineligible GitHub URLs excluded even when a reader claims them", async () => {
    Object.assign(provider, {
      readers: [
        {
          ...TEST_LINK_READER,
          linkReader: { ...TEST_LINK_READER.linkReader, pathPattern: "^/.*$" },
        },
      ],
    });
    const links = await show([
      "https://github.com/login",
      "https://github.com/settings/profile",
      href(1),
    ]);
    expect([...observer().targets]).toEqual([links[2]]);
    observer().intersect(links);
    await vi.advanceTimersByTimeAsync(500);
    expect(prefetch.mock.calls.map(([anchor]) => anchor)).toEqual([links[2]]);
  });

  it("refreshes negative classifications after capabilities change", async () => {
    Object.assign(provider, { readers: [] });
    await show();
    const [link] = await show();
    expect(observer().targets.size).toBe(0);
    Object.assign(provider, { readers: [TEST_LINK_READER] });
    provider.dispatchEvent(new Event("link-reader-capabilities-changed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.has(link!)).toBe(true);
  });

  it("keeps nested provider claims current without reclassifying unaffected links", async () => {
    const [outer] = await show();
    const inner = installTestLinkReader(
      document.createElement(linkTargets.LINK_READER_HOVERCARD_PROVIDER_TAG),
    );
    const link = document.createElement("a");
    link.href = href(2);
    inner.append(link);
    container.firstElementChild!.append(inner);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.has(link)).toBe(true);
    const gate = vi.spyOn(linkTargets, "isPreviewAnchor");
    Object.assign(inner, { readers: [] });
    container.firstElementChild!.append(document.createTextNode("delta"));
    await vi.advanceTimersByTimeAsync(0);
    expect([...observer().targets]).toEqual([outer]);
    expect(gate).not.toHaveBeenCalled();
    Object.assign(inner, { readers: [TEST_LINK_READER] });
    container.firstElementChild!.append(document.createTextNode("delta"));
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.mock.calls.map(([anchor]) => anchor)).toEqual([link]);
    expect(observer().targets.has(link)).toBe(true);
  });

  it("warms only intersecting item links and deduplicates alternate permalinks", async () => {
    const links = await show([
      href(1),
      `${href(1)}#issuecomment-2`,
      href(2),
      "https://github.com/openclaw/openclaw",
    ]);
    expect(observer().targets.size).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).not.toHaveBeenCalled();

    observer().intersect([links[0]!, links[1]!]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch.mock.calls[0]![0].href).toBe(href(1));

    observer().intersect([links[2]!]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it("runs one background request at a time with an eight-item transcript budget", async () => {
    const first = createDeferred();
    prefetch.mockImplementationOnce(() => first.promise);
    const links = await show([
      `${href(1)}#issuecomment-2`,
      ...Array.from({ length: 12 }, (_, index) => href(index + 1)),
    ]);
    observer().intersect(links);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prefetch).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prefetch).toHaveBeenCalledTimes(8);
    expect(observer().targets.size).toBe(0);
    await show([href(50)]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).toHaveBeenCalledTimes(8);

    const next = await show([href(50)], "second");
    observer().intersect(next);
    await vi.advanceTimersByTimeAsync(200);
    expect(prefetch).toHaveBeenCalledTimes(9);
  });

  it("warms an exhausted conversation again after the Gateway reconnects", async () => {
    const hrefs = Array.from({ length: 8 }, (_, index) => href(index + 1));
    const links = await show(hrefs);
    observer().intersect(links);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prefetch).toHaveBeenCalledTimes(8);

    await show(hrefs, "first", true, false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).toHaveBeenCalledTimes(8);
    const resumed = await show(hrefs);
    observer().intersect(resumed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prefetch).toHaveBeenCalledTimes(16);
  });

  it("drops links that leave the viewport or are removed before queued work starts", async () => {
    const links = await show([href(1), href(2)]);
    observer().intersect(links);
    observer().intersect([links[0]!], false);
    links[1]!.remove();
    await vi.advanceTimersByTimeAsync(500);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("discovers streamed links and recycled hrefs without another parent render", async () => {
    await show([]);
    const link = document.createElement("a");
    link.className = "markdown-github-link";
    link.href = href(1);
    container.firstElementChild!.append(link);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer().targets.has(link)).toBe(true);
    observer().intersect([link]);
    await vi.advanceTimersByTimeAsync(200);
    link.href = href(2);
    await vi.advanceTimersByTimeAsync(0);
    observer().intersect([link]);
    await vi.advanceTimersByTimeAsync(200);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it.each(["pane", "document", "disconnect"])(
    "releases pending work when hidden by %s",
    async (hiddenBy) => {
      const pending = createDeferred();
      prefetch.mockImplementationOnce(() => pending.promise);
      const links = await show([href(1), href(2)]);
      const oldObserver = observer();
      oldObserver.intersect(links);
      await vi.advanceTimersByTimeAsync(200);
      const signal = prefetch.mock.calls[0]![1];
      if (hiddenBy === "pane") {
        await show([href(1), href(2)], "first", false);
      } else if (hiddenBy === "document") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        render(nothing, container);
      }
      expect(signal.aborted).toBe(true);
      expect(oldObserver.targets.size).toBe(0);
      oldObserver.intersect(links);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prefetch).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
      const resumed = await show([href(1)]);
      observer().intersect(resumed);
      await vi.advanceTimersByTimeAsync(200);
      expect(prefetch).toHaveBeenCalledTimes(2);
      expect(prefetch.mock.calls[1]![0].href).toBe(href(1));
    },
  );

  it("does not let a retired session drain the next session's queue", async () => {
    const old = createDeferred();
    const next = createDeferred();
    prefetch.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    const links = await show([href(1), href(2)]);
    observer().intersect(links);
    await vi.advanceTimersByTimeAsync(200);
    const nextLinks = await show([href(3), href(4)], "second");
    observer().intersect(nextLinks);
    await vi.advanceTimersByTimeAsync(200);
    old.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).toHaveBeenCalledTimes(2);
    next.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(prefetch).toHaveBeenCalledTimes(3);
    expect(prefetch.mock.calls[0]![1].aborted).toBe(true);
    expect(prefetch.mock.calls[2]![0].href).toBe(href(4));
  });

  it("leaves requests to hover when visibility observation is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await show();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prefetch).not.toHaveBeenCalled();
  });
});

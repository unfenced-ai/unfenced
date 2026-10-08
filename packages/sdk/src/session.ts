/**
 * The `Session` handle - a thin façade over the live-session methods on the
 * `Unfenced` client. Moved out of the single-file entry unchanged; every method
 * still delegates to `this.client`, so its behaviour is exactly the client's.
 */
import type { Unfenced } from "./client.js";
import type { ExtractedDoc } from "./protocol.js";
import type {
  Action,
  ActExpectation,
  ActResult,
  DownloadInfo,
  Format,
  OnAction,
  PageSnapshot,
  ProviderSessionReason,
} from "./types.js";

/** Options that change how an action is reported, not what the page is asked to do. */
export interface SessionActOptions {
  acceptDialog?: boolean;
  dialogText?: string;
  brief?: boolean;
  see?: boolean;
  expect?: ActExpectation;
}

/**
 * A handle to one live browser session.
 *
 * Keep it around across steps: observe to see what is on the page, act to
 * change it, extract to read it clean, screenshot to watch it. Refs come from
 * the latest snapshot and go stale on navigation - observe again after acting.
 */
export class Session {
  constructor(
    private readonly client: Unfenced,
    public readonly id: string,
    /** The snapshot from when the session opened. */
    public readonly initial: PageSnapshot,
  ) {}

  observe(opts?: {
    match?: string;
    maxControls?: number;
    maxLinks?: number;
    excerptChars?: number;
    media?: boolean;
  }): Promise<PageSnapshot> {
    return this.client.observe(this.id, opts);
  }
  /**
   * Re-read the page after a reconnect and retain the provider continuity
   * signal returned by the worker.
   */
  refresh(opts?: { match?: string }): Promise<{
    page: PageSnapshot;
    providerSession?: ProviderSessionReason;
  }> {
    return this.client.refresh(this.id, opts);
  }
  act(action: Action | OnAction, opts?: SessionActOptions): Promise<ActResult> {
    return this.client.act(this.id, action, opts);
  }
  click(ref: string, opts: { confirm?: boolean } & SessionActOptions = {}): Promise<ActResult> {
    const { confirm, ...reporting } = opts;
    return this.act(
      { kind: "click", ref, ...(confirm !== undefined ? { confirm } : {}) },
      reporting,
    );
  }
  type(
    ref: string,
    text: string,
    opts: { submit?: boolean; confirm?: boolean; append?: boolean } & SessionActOptions = {},
  ): Promise<ActResult> {
    const { submit, confirm, append, ...reporting } = opts;
    return this.act(
      {
        kind: "type",
        ref,
        text,
        ...(submit !== undefined ? { submit } : {}),
        ...(confirm !== undefined ? { confirm } : {}),
        ...(append !== undefined ? { append } : {}),
      },
      reporting,
    );
  }
  select(ref: string, value: string, opts: SessionActOptions = {}): Promise<ActResult> {
    return this.act({ kind: "select", ref, value }, opts);
  }
  press(key: string, opts: { confirm?: boolean } & SessionActOptions = {}): Promise<ActResult> {
    const { confirm, ...reporting } = opts;
    return this.act(
      { kind: "press", key, ...(confirm !== undefined ? { confirm } : {}) },
      reporting,
    );
  }
  scroll(to: "top" | "bottom" | { ref: string }, opts: SessionActOptions = {}): Promise<ActResult> {
    return this.act({ kind: "scroll", to }, opts);
  }
  /** `settleMs` is the pause after the document commits, not the navigation's
   *  own timeout - see the `navigate` action. Default 4000, maximum 15000. */
  navigate(url: string, opts: { settleMs?: number } & SessionActOptions = {}): Promise<ActResult> {
    const { settleMs, ...reporting } = opts;
    return this.act(
      { kind: "navigate", url, ...(settleMs !== undefined ? { settleMs } : {}) },
      reporting,
    );
  }
  back(opts: SessionActOptions = {}): Promise<ActResult> {
    return this.act({ kind: "back" }, opts);
  }
  extract(
    format: Format = "markdown",
    maxWords?: number,
  ): Promise<{
    doc: ExtractedDoc;
    content: string;
    url: string;
    contentTruncated?: boolean;
    totalWords?: number;
  }> {
    return this.client.extract(this.id, format, maxWords);
  }
  park(minutes?: number, reason?: string) {
    return this.client.park(this.id, minutes, reason);
  }
  downloads(): Promise<{ downloads: DownloadInfo[] }> {
    return this.client.downloads(this.id);
  }
  readDownload(filename: string) {
    return this.client.readDownload(this.id, filename);
  }
  screenshot(): Promise<string> {
    return this.client.screenshot(this.id);
  }
  close(): Promise<{ alreadyClosed?: boolean; wasOpen?: boolean }> {
    // Mirrors closeSession's own signature deliberately. Narrowing it here
    // drops `wasOpen` for every caller that goes through a Session - the
    // defect the comment on that method exists to prevent.
    return this.client.closeSession(this.id);
  }
}

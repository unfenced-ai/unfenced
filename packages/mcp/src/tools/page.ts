/**
 * Working an open page (short of `act` itself, which sits in the barrel beside
 * the schema it is bound to).
 *
 * observe_page and see_page read it, fill_form writes several fields at once,
 * park_page holds it open while you wait, read_download reads a file it fetched,
 * and close_page releases it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Unfenced } from "@unfenced-ai/sdk";
import {
  asToolResult,
  toolError,
  parseDataUri,
  seeLegend,
  plainLegend,
  type SeenView,
  DEFAULT_DOWNLOAD_CHARS,
  MAX_FORM_FIELDS,
  WEB_READ,
} from "./shared.js";

export function registerObservePage(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "observe_page",
    {
      title: "Look at a live page again",
      description:
        "Re-read an open page without acting: after a slow load, or to find a control the snapshot " +
        "left out. IF YOU CAN READ SOMETHING IN `excerpt` THAT IS NOT IN `controls`, it is an " +
        "element the page never declared as a control - do not hunt for a ref and do not fall back " +
        "to arrow keys: act on it with `on` and its visible words. " +
        "`match` filters by visible name across the WHOLE page - use it to find one " +
        "control on a page with thousands. " +
        "IF THE REPLY CARRIES `undeclared`, READ IT FIRST. Those are things the page DRAWS as " +
        "clickable and never declared as controls, so they have no ref and no amount of observing " +
        "will give them one - act on them with `on` and their visible words. This is the single " +
        "most common reason a page looks undriveable: a real booking site answered a search with " +
        "13 controls, not one of them a time, beside an excerpt listing every available slot. Both " +
        "true, neither actionable by ref, and the agent stopped while the answer was on screen. " +
        "IF THE REPLY CARRIES `look`, THIS READING IS NOT THE WHOLE PAGE and it says why in " +
        "words: a screen that is mostly canvas or picture, or controls the page never named, " +
        'whose names here are placeholders like "unlabelled button". WHEN THAT HAPPENS A ' +
        "PICTURE COMES WITH THE READING - you do not have to ask for it and should not spend a " +
        "call doing so. Every control on it is outlined and numbered, and the legend beside it " +
        "gives each mark's ref, so act on what you can see. It arrives once per page per reason " +
        "rather than on every read; call see_page yourself if you want another. `look` is ABSENT " +
        "on pages where this reading stands on its own, which is most of them. " +
        "THE REPLY SAYS WHAT IT LEFT OUT, in `truncated`. A non-zero count there is not a warning " +
        "to ignore: the page has more than you were shown, and the ones you were shown are simply " +
        "the ones that came first in the document. Narrow with `match` when you know what you are " +
        "looking for, or raise `maxControls` / `maxLinks` when you genuinely need the whole set. " +
        "Prefer `match` - it costs a fraction of the tokens and finds the thing anywhere on the page. " +
        "WHEN SOMETHING WAS LEFT OUT, `more.reason` says so in the same reply and tells you which " +
        "knob to turn. Read it before you conclude a control is not on the page: four separate " +
        '"this is missing" reports in one audit were all content one parameter away.',
      inputSchema: {
        sessionId: z.string(),
        match: z
          .string()
          .optional()
          .describe('Only elements whose name contains this, e.g. "next"'),
        maxControls: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How many controls to return. Default 80, ceiling 400. Raise it when `truncated." +
              "controls` is non-zero AND you cannot narrow with `match` - a big page costs real " +
              "tokens, and one page in our own corpus serves 1,221 controls.",
          ),
        maxLinks: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How many links to return. Default 40, ceiling 200. Links are the largest part of a " +
              "snapshot on most pages, so raise this only when you are actually navigating by them.",
          ),
        excerptChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How much of the page's visible text to return in `excerpt`. Default 1500, ceiling " +
              "8000. Raise it when the page's ANSWER is its prose - a results list, a policy, an " +
              "order confirmation - and the default stops mid-sentence. It is the cheap " +
              "alternative to extract_page on a page you already have open, and it is shared " +
              "across every frame rather than granted to each.",
          ),
        media: z
          .boolean()
          .optional()
          .describe(
            "Also list the page's saveable media in `media`: each picture, video or embed " +
              "at least 64x64, with a `ref` you hand straight to `save`, its `kind`, a `name` " +
              "(alt text, or a filename), and its `w`/`h`. A content image is not a control and " +
              "appears nowhere else in the reading, so this is how you FIND one to save. Off by " +
              "default because it is extra payload - ask for it only when you mean to save media.",
          ),
      },
      annotations: WEB_READ,
    },
    async ({ sessionId, match, maxControls, maxLinks, excerptChars, media }) => {
      try {
        const read = await cloud.read(sessionId, {
          ...(match ? { match } : {}),
          ...(maxControls ? { maxControls } : {}),
          ...(maxLinks ? { maxLinks } : {}),
          ...(excerptChars ? { excerptChars } : {}),
          ...(media ? { media: true } : {}),
        });

        /**
         * A PICTURE ARRIVES WITH THE READING when the reading cannot describe
         * the page, rather than after the agent decides to ask for one.
         *
         * That decision was the hardest one to make well: choosing to look
         * requires knowing what the text failed to say, which is the one thing a
         * text reading cannot tell you. So the page decides instead, on the
         * measured signal it already computes, and the agent simply has it.
         *
         * The image goes AFTER the reading and before the explanation, so a
         * client rendering blocks in order gets: what is on the page, what it
         * looks like, why it was sent.
         */
        const frame = read.picture ? parseDataUri(read.picture) : null;
        if (!frame) return asToolResult({ page: read.page });

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ page: read.page }) },
            { type: "image" as const, data: frame.data, mimeType: frame.mimeType },
            {
              type: "text" as const,
              text:
                `This picture came WITH the reading because ${read.page.look?.reason ?? "the reading is thin"} ` +
                "You did not ask for it and do not need to ask again. " +
                // Said only when it is true. The sentence used to promise an
                // outlining unconditionally, and on a page whose controls had all
                // been filtered away it described an image with nothing drawn on it.
                (read.marks?.length
                  ? "Every control on it is outlined and numbered; each mark below carries its own " +
                    "`ref` and `mark` number - read a box's number, find that mark in the list, and act on its `ref`. "
                  : "Nothing on this screen could be outlined, so there are no marks to go by - " +
                    "act on what you can see with `on` and its words. ") +
                JSON.stringify({
                  marks: read.marks ?? [],
                  ...(read.pictureNote ? { note: read.pictureNote } : {}),
                }),
            },
          ],
        };
      } catch (error) {
        return asToolResult(toolError("observe-failed", error), true);
      }
    },
  );
}

export function registerSeePage(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "see_page",
    {
      title: "See a live page",
      description:
        "A picture of an open page, WITH EVERY CONTROL OUTLINED AND NUMBERED so you can act on " +
        "what you see: mark 3 on the image is controls[2] in the list returned beside it, by " +
        "construction, so read a box and click its ref. Use it to see what the DOM cannot say - " +
        "a chart or canvas, an icon button whose name is empty, a visual layout, which of four " +
        "identical rows is highlighted, whether an act actually changed anything. " +
        "observe_page is cheaper and stays the default for reading and acting; reach for this " +
        "when you cannot tell WHERE something is, when a name is blank or means nothing, when " +
        "the page is visual, or when you are stuck after a refusal. Note what is NOT boxed: " +
        "things the page draws as clickable and never declared have no ref, so they arrive in " +
        "undeclared instead and are clicked with `on` and their words. The image is the current " +
        "viewport only - scroll and see again for what is below the fold.",
      inputSchema: {
        sessionId: z.string().describe("From open_page"),
        marks: z
          .boolean()
          .optional()
          .describe(
            "Outline and number the controls. Default true, and worth keeping: it is what makes " +
              "a picture actionable rather than just informative. Pass false for a clean picture " +
              "of the page as it really looks - showing a screen to a person, or reading a " +
              "chart the boxes would sit on top of.",
          ),
        links: z
          .boolean()
          .optional()
          .describe(
            "Box the links too, numbered after the controls. Off by default because a page with " +
              "two hundred links is papered over by its own boxes, and a link is usually " +
              "reachable by the words printed on it. Worth it for a navigation of links that all " +
              "read the same - 'Read more', 'Details' - where only position tells them apart.",
          ),
        maxMarks: z
          .number()
          .int()
          .optional()
          .describe(
            "How many boxes to draw. Default 50, ceiling 120; anything else falls back to 50. " +
              "Raise it when the reply's note says boxes were left undrawn AND the thing you are " +
              "looking for is one of them - past roughly 120 the labels overlap and the picture " +
              "gets harder to read, not easier.",
          ),
      },
      annotations: WEB_READ,
    },
    async ({ sessionId, marks, links, maxMarks }) => {
      try {
        const wants = marks !== false;
        const view = wants
          ? await cloud.see(sessionId, {
              ...(links ? { links: true } : {}),
              ...(maxMarks === undefined ? {} : { maxMarks }),
            })
          : { image: await cloud.screenshot(sessionId) };
        const frame = parseDataUri(view.image);
        if (!frame) {
          return asToolResult(
            { error: "no-frame", detail: "no screenshot is available for this session yet" },
            true,
          );
        }
        // An image content block, not text: the caller's own vision model reads
        // the pixels. The text block beside it is what makes the picture
        // ACTIONABLE — without the legend, a mark is a number on a box and an
        // agent still has nothing to send.
        const legend = wants ? seeLegend(view as SeenView) : plainLegend(sessionId);
        return {
          content: [
            { type: "image" as const, data: frame.data, mimeType: frame.mimeType },
            { type: "text" as const, text: legend },
          ],
        };
      } catch (error) {
        return asToolResult(toolError("see-failed", error), true);
      }
    },
  );
}

export function registerFillForm(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "fill_form",
    {
      title: "Fill several fields at once",
      description:
        "Write into several fields in ONE call, naming each by the words the page shows a " +
        "person - its label or its placeholder. Use it whenever you are about to fill two or " +
        "more fields: a checkout, a booking, a sign-up. Each field goes through exactly the " +
        "same checks as a single act, so nothing is skipped and nothing is trusted more. " +
        "IT NEVER SUBMITS AND NEVER CLICKS, which is what makes it safe to send again: writing " +
        "a value is repeatable, so if one field is refused you can fix that field and re-send " +
        "the whole call. Submit afterwards with act, once, deliberately. " +
        "NOT FOR PASSWORDS - use act with fill_secret and a stored credential's name; a secret " +
        "never travels as text. The reply carries one entry per field in the order you sent " +
        "them, so a partial failure names exactly which one refused and why. " +
        `AT MOST ${MAX_FORM_FIELDS} FIELDS PER CALL - a longer list is refused outright rather than ` +
        "quietly cut, so split a long form into consecutive calls; nothing is submitted between them. " +
        "On a transport timeout, execution-uncertain means the fields may already have been written - observe before retrying.",
      inputSchema: {
        sessionId: z.string().describe("From open_page"),
        fields: z
          .array(
            z.object({
              ref: z.string().optional().describe("From the last snapshot"),
              on: z
                .string()
                .optional()
                .describe(
                  "The field's visible words - its label or placeholder. Needs this or ref.",
                ),
              within: z
                .string()
                .optional()
                .describe("Narrow `on` to one region, when a page has two of the same field"),
              text: z.string().describe("What to write. Never a password."),
              append: z
                .boolean()
                .optional()
                .describe("Add to what is there instead of replacing it. Default replaces."),
            }),
          )
          // The ceiling is enforced HERE, at the wire, not left to the engine.
          // The engine silently truncated past it and still reported ok, so a
          // 30-field registration came back looking complete with six fields
          // never written. The MCP SDK validates this schema server-side before
          // the handler runs, so a connector holding a stale cached schema is
          // refused too.
          .max(
            MAX_FORM_FIELDS,
            `fill_form takes at most ${MAX_FORM_FIELDS} fields in one call - send the rest in a second call`,
          )
          .describe(
            `The fields to write, in the order they should be filled. At most ${MAX_FORM_FIELDS}`,
          ),
      },
      // NOT destructive and IS idempotent, unlike `act` — and the difference is
      // the feature rather than a nicety of labelling. Writing a value can be
      // repeated safely; that is exactly why a batch is allowed to contain
      // fills and is not allowed to contain the submit at the end of them.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, fields }) => {
      try {
        return asToolResult(await cloud.fill(sessionId, fields));
      } catch (error) {
        return asToolResult(toolError("fill-failed", error), true);
      }
    },
  );
}

export function registerParkPage(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "park_page",
    {
      title: "Hold a page open while you wait",
      description:
        "Hold an open page while something happens elsewhere: a code sent to email or SMS, an " +
        "approval in another app, a person finishing something in the headed window. A page " +
        "closes on its own after 5 minutes idle, or 15 once it has been acted on; parking " +
        "gives it 30. That matters because a login that has got as far as an emailed code has " +
        "been acted on, and what a close destroys is exactly what it is standing on: cookies " +
        "and localStorage survive, sessionStorage and anything typed do not. A parked page " +
        "holds a real browser tab, so only a few may be parked at once; acting on the page " +
        "ends the park.",
      inputSchema: {
        sessionId: z.string().describe("From open_page"),
        minutes: z.number().int().positive().optional().describe("Up to 30. Default 30."),
        reason: z
          .string()
          .optional()
          .describe("What you are waiting for. Shown in the session list and the audit log."),
      },
      annotations: WEB_READ,
    },
    async ({ sessionId, minutes, reason }) => {
      try {
        return asToolResult(await cloud.park(sessionId, minutes, reason));
      } catch (error) {
        return asToolResult(toolError("park-failed", error), true);
      }
    },
  );
}

export function registerReadDownload(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "read_download",
    {
      title: "Read a file the page downloaded",
      description:
        "Read a file an open page downloaded. Clicking a download link records the file and the " +
        "act result names it; this reads it as text. A PDF goes through the same reader a " +
        "fetched PDF does, so downloading a statement and reading it is one capability. Call " +
        "with no filename to list what this session has. A spreadsheet, an image or a zip is " +
        `downloaded and its size known, but there is nothing to read out of it. The text is ` +
        `capped at ${DEFAULT_DOWNLOAD_CHARS.toLocaleString("en-US")} characters unless maxChars says otherwise; the reply then carries ` +
        "contentTruncated and totalChars, and `bytes` is the whole file either way.",
      inputSchema: {
        sessionId: z.string().describe("From open_page"),
        filename: z
          .string()
          .optional()
          .describe("As named in the act result. Omit to list this session's downloads."),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Cap the text at this many characters (default ${DEFAULT_DOWNLOAD_CHARS}); the reply then carries contentTruncated and totalChars`,
          ),
      },
      annotations: WEB_READ,
    },
    async ({ sessionId, filename, maxChars }) => {
      try {
        if (!filename) return asToolResult(await cloud.downloads(sessionId));
        const read = await cloud.readDownload(sessionId, filename);
        // BOUNDED. The schema was `sessionId` and `filename` only and this
        // passed `read.content` through whole, with nothing downstream capping
        // it: a site answering an export link with a large CSV, JSON or log —
        // an "export" button is the ordinary way to reach this — destroyed the
        // caller's context in one call. Every other reader here has a budget;
        // this one had none, and the tool's own reply is where the cost lands.
        //
        // `bytes` still reports the WHOLE file, so a caller can tell how much
        // it is not being shown, and ask for more.
        const cap = maxChars ?? DEFAULT_DOWNLOAD_CHARS;
        const whole = read.content ?? "";
        const cut = whole.length > cap;
        return asToolResult({
          filename: read.filename,
          bytes: read.bytes,
          title: read.doc.title,
          wordCount: read.doc.wordCount,
          ...(cut ? { contentTruncated: true, totalChars: whole.length } : {}),
          content: cut ? whole.slice(0, cap) : whole,
        });
      } catch (error) {
        return asToolResult(toolError("read-download-failed", error), true);
      }
    },
  );
}

export function registerClosePage(server: McpServer, cloud: Unfenced): void {
  // A remote stdio client cannot see the worker's capacity config, while the
  // mounted MCP server can. State a number only when this process knows it.
  const machineLimit = Number(process.env["UNFENCED_MAX_SESSIONS"]);
  const machineCapacity =
    Number.isSafeInteger(machineLimit) && machineLimit > 0
      ? `the machine-wide ceiling behind that is ${machineLimit}. `
      : "the worker also enforces its configured machine-wide ceiling. ";
  const tenantLimit = Number(process.env["UNFENCED_MAX_SESSIONS_PER_TENANT"]);
  const tenantCapacity =
    Number.isSafeInteger(tenantLimit) && tenantLimit > 0
      ? `The hosted service allows ${tenantLimit} live pages per account; another open is refused with tenant-session-limit - `
      : "The hosted service enforces its configured per-account live-page limit - ";
  server.registerTool(
    "close_page",
    {
      title: "Close a live page",
      description:
        "Release an open page - it holds a real browser tab on the worker. Close a THROWAWAY or " +
        "read-only page when you are done with it, and to free a slot. " +
        tenantCapacity +
        machineCapacity +
        "But do NOT close a page you SIGNED INTO (behind a login or 2FA) just because you finished " +
        "ONE question: closing loses the live signed-in page, and a follow-up would have to log in " +
        "and clear 2FA all over again (a signed-in site's session does not fully survive a close). " +
        "Leave it open instead - an idle page self-closes on its own (about 5 min if only read, " +
        "15 min once acted on), so a follow-up within that window reuses the SAME authenticated page " +
        "with no re-login. Close a signed-in page only when the user says they are done with that " +
        "site, or you need the slot. Call with no session id to list what is currently open. " +
        "Idempotent: closing a page that is already gone succeeds. Check wasOpen - false means " +
        "nothing was released, so the id may be wrong and your real page may still be open.",
      inputSchema: {
        sessionId: z.string().optional().describe("Omit to list open pages instead of closing one"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) => {
      try {
        if (!sessionId) return asToolResult({ open: await cloud.liveSessions() });
        const result = await cloud.closeSession(sessionId);
        // Releasing a resource is idempotent: a page that has already closed —
        // by an earlier call, or by idling out, which the description says
        // happens after a few minutes — is the state the caller asked for. An
        // agent closing in a finally block must not be punished for a slow task.
        const wasOpen = (result as { wasOpen?: boolean })?.wasOpen !== false;
        return asToolResult({
          closed: sessionId,
          wasOpen,
          ...(wasOpen
            ? {}
            : {
                // A mistyped id used to report as `alreadyClosed`, which reads
                // as "you already did this" and let a caller believe they had
                // released a page while their real one stayed open until the
                // reaper. Say what is actually known instead.
                detail:
                  "nothing was released - no open page with that id. It may have closed already, " +
                  "idled out, or the id may be wrong. Call close_page with no id to list what is open.",
              }),
        });
      } catch (error) {
        return asToolResult(toolError("close-failed", error), true);
      }
    },
  );
}

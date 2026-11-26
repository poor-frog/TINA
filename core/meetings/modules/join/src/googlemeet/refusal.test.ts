import {
  checkForGoogleJoinRefused,
  GoogleJoinRefusedError,
  knockUntilGoogleAccepts,
  watchGoogleJoinRefusal,
  GOOGLE_JOIN_MAX_KNOCKS,
  GOOGLE_JOIN_REFUSED,
} from "./refusal";
import { AdmissionError } from "../shared/admission";
import { getJoinBrowserArgs } from "../browser-args";
import { waitForAnySelector, waitForLobbyCta } from "./join";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) { console.log(`  PASS ${name}`); passed++; }
  else { console.error(`  FAIL ${name}`); failed++; }
}

const response = (status: number, url: string) => ({ status: () => status, url: () => url });
function mockPage() {
  let onResponse: ((response: ReturnType<typeof response>) => void) | undefined;
  let waits = 0;
  const page: any = {
    on: (event: string, listener: typeof onResponse) => { if (event === "response") onResponse = listener; },
    emitResponse: (value: ReturnType<typeof response>) => onResponse?.(value),
    url: () => "https://meet.google.com/abc-defg-hij",
    locator: (selector: string) => ({ first: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async () => {
      if (++waits === 1) page.emitResponse(response(403, "https://meet.google.com/$rpc/MeetingDeviceService/CreateMeetingDevice"));
    },
    screenshot: async () => {},
    evaluate: async () => ({ lang: "en", nav: "en-US" }),
    evaluateHandle: async () => ({
      getProperty: async () => ({ jsonValue: async () => [], asElement: () => null }),
      dispose: async () => {},
    }),
  };
  return page;
}

(async () => {
  console.log("\n=== Google Meet refusal retry ===");

  {
    const page = mockPage();
    watchGoogleJoinRefusal(page);
    watchGoogleJoinRefusal(page);
    page.emitResponse(response(403, "https://meet.google.com/$rpc/MeetingDeviceService/CreateMeetingDevice"));
    const evidence = await checkForGoogleJoinRefused(page);
    check("watches the relevant 403 once per page", evidence === "CreateMeetingDevice answered HTTP 403");
    page.emitResponse(response(403, "https://meet.google.com/$rpc/UnrelatedService/Call"));
    check("ignores unrelated 403 responses", (await checkForGoogleJoinRefused(page)) === evidence);
  }

  {
    const page: any = {
      locator: (selector: string) => ({ first: () => ({
        isVisible: async () => selector.includes("You can’t join this video call"),
      }) }),
    };
    check("recognizes the visible typographic refusal copy", (await checkForGoogleJoinRefused(page)) !== null);
  }

  {
    const page = mockPage();
    watchGoogleJoinRefusal(page);
    const nameError = await waitForAnySelector(page, ["input[type=text]"], 120_000, "name input").catch((e) => e);
    check("403 during name-field wait exits early with typed refusal", nameError instanceof GoogleJoinRefusedError);
  }

  {
    const page = mockPage();
    watchGoogleJoinRefusal(page);
    const ctaError = await waitForLobbyCta(page, ['button:has-text("Ask to join")'], 60_000, "join button").catch((e) => e);
    check("403 during join-button wait exits early with typed refusal", ctaError instanceof GoogleJoinRefusedError);
  }

  {
    const page: any = {};
    let knocks = 0;
    const admitted = await knockUntilGoogleAccepts(page, 60_000, async () => {
      if (++knocks < 3) throw new GoogleJoinRefusedError("ResolveMeetingSpace answered HTTP 403");
      return true;
    });
    check("retries a transient refusal and admits on the third knock", admitted && knocks === 3);
  }

  {
    const page: any = {};
    let knocks = 0;
    const error = await knockUntilGoogleAccepts(page, 60_000, async () => {
      knocks++;
      throw new GoogleJoinRefusedError("CreateMeetingDevice answered HTTP 403");
    }).catch((e) => e);
    check("bounds repeated refusals to three knocks", knocks === GOOGLE_JOIN_MAX_KNOCKS);
    check("returns a typed denial with the refusal marker and knock count",
      error instanceof GoogleJoinRefusedError && error.outcome === "denial"
      && error.message.startsWith(`${GOOGLE_JOIN_REFUSED}:`)
      && error.message.includes("3 of 3 knocks"));
  }

  {
    const page: any = {};
    const hostDenial = new AdmissionError("denial", "host denied");
    const error = await knockUntilGoogleAccepts(page, 60_000, async () => { throw hostDenial; }).catch((e) => e);
    check("does not retry a host denial", error === hostDenial);
  }

  for (const [label, failure] of [
    ["lobby timeout", new AdmissionError("lobby_timeout", "still in the waiting room")],
    ["browser crash", new Error("Target page, context or browser has been closed")],
  ] as const) {
    let knocks = 0;
    const error = await knockUntilGoogleAccepts({} as any, 60_000, async () => {
      knocks++;
      throw failure;
    }).catch((e) => e);
    check(`does not retry ${label}`, knocks === 1 && error === failure);
  }

  {
    let knocks = 0;
    const admitted = await knockUntilGoogleAccepts({} as any, 60_000, async () => {
      knocks++;
      return true;
    });
    check("keeps the first successful admission without another knock", admitted && knocks === 1);
  }

  {
    let clock = 0;
    const budgets: number[] = [];
    const error = await knockUntilGoogleAccepts({} as any, 30_000, async (remaining) => {
      budgets.push(remaining);
      clock += 20_000;
      throw new GoogleJoinRefusedError("ResolveMeetingSpace answered HTTP 403");
    }, () => clock).catch((e) => e);
    check("re-knocks use only the remaining admission budget", budgets.join(",") === "30000,10000");
    check("stops retrying when the original budget is exhausted", budgets.length === 2 && error instanceof GoogleJoinRefusedError);
  }

  {
    let cookiesCleared = 0;
    let storageCleared = 0;
    const delays: number[] = [];
    const page: any = {
      context: () => ({ clearCookies: async () => { cookiesCleared++; } }),
      evaluate: async () => { storageCleared++; },
    };
    let knocks = 0;
    const admitted = await knockUntilGoogleAccepts(
      page,
      60_000,
      async () => {
        if (++knocks < 3) throw new GoogleJoinRefusedError("ResolveMeetingSpace answered HTTP 403");
        return true;
      },
      Date.now,
      {
        authenticated: false,
        backoffMs: (attempt) => attempt * 1000,
        sleep: async (ms) => { delays.push(ms); },
      },
    );
    check("anonymous retry clears cookies+storage and backs off before re-knocking",
      admitted && cookiesCleared === 2 && storageCleared === 2 && delays.join(",") === "1000,2000");
  }

  {
    let cookiesCleared = 0;
    const page: any = {
      context: () => ({ clearCookies: async () => { cookiesCleared++; } }),
      evaluate: async () => { cookiesCleared++; },
    };
    let knocks = 0;
    const admitted = await knockUntilGoogleAccepts(
      page,
      60_000,
      async () => {
        if (++knocks < 2) throw new GoogleJoinRefusedError("CreateMeetingDevice answered HTTP 403");
        return true;
      },
      Date.now,
      { authenticated: true, backoffMs: () => 0 },
    );
    check("authenticated retry preserves signed-in cookies across knocks", admitted && cookiesCleared === 0);
  }

  {
    const anonArgs = getJoinBrowserArgs();
    const authArgs = getJoinBrowserArgs({ authenticated: true });
    check("join browser args include --disable-dev-shm-usage for Fargate",
      anonArgs.includes("--disable-dev-shm-usage") && authArgs.includes("--disable-dev-shm-usage"));
    check("anonymous join keeps --incognito while authenticated join strips --incognito",
      anonArgs.includes("--incognito") && !authArgs.includes("--incognito"));
  }

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();

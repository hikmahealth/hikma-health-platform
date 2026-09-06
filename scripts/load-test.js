import http from "k6/http";
import { check, sleep } from "k6";

// Target URL is read from the LOAD_TEST_URL environment variable.
// Pass it in at runtime: k6 run -e LOAD_TEST_URL=https://example.com load-test.js
const URL = __ENV.LOAD_TEST_URL;

if (!URL) {
  throw new Error("LOAD_TEST_URL environment variable is not set");
}

export const options = {
  scenarios: {
    two_thousand_per_minute: {
      executor: "constant-arrival-rate",
      // 2000 requests per minute ≈ 33.34/sec
      rate: 2000,
      timeUnit: "1m",
      duration: "1m",
      // Pool of VUs k6 can use to hit the target rate.
      // Bump maxVUs up if the endpoint is slow and requests start queuing.
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  // thresholds: {
  //   http_req_failed: ["rate<0.01"], // fail the test if >1% of requests error
  //   http_req_duration: ["p(95)<1000"], // fail if p95 latency exceeds 1s
  // },
};
const payload = __ENV.LOAD_TEST_BODY ?? undefined;

export default function () {
  const res = http.get(URL, {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/json",
    },
  });

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}

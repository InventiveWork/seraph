# Load Testing the Seraph Agent

Performance is a key feature of the Seraph agent. This document provides a guide on how to load test the agent to understand its capacity, measure its request rate, and determine optimal batch sizes.

We recommend using [k6](https://k6.io/), a powerful and easy-to-use open-source load testing tool.

## 1. Installation

First, install k6 on your system.

-   **macOS:** `brew install k6`
-   **Linux:** `sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list && sudo apt-get update && sudo apt-get install k6`
-   **Windows:** `winget install k6`

For other installation methods, see the [official k6 documentation](https://k6.io/docs/getting-started/installation/).

## 2. Preparing for the Test

### Target Endpoint

The primary endpoint for load testing is `/logs` on the Seraph server, as this is where the highest volume of traffic will occur.

### Test Payload

You need a realistic log payload to send. You can use the provided `log_payload.txt` file or create your own. For this guide, we'll assume a simple JSON log.

### Create a Test Script

Create a file named `load-test.js`. This script will define the test scenario.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

// The log payload you want to send.
// For a more realistic test, you could load this from a file.
const payload = JSON.stringify({
  level: 'error',
  message: 'Failed to connect to database',
  timestamp: new Date().toISOString(),
  service: 'payment-service',
});

const params = {
  headers: {
    'Content-Type': 'application/json',
    // Uncomment the line below if you have an API key configured in Seraph
    // 'Authorization': 'Bearer YOUR_SERAPH_API_KEY',
  },
};

export default function () {
  const res = http.post('http://localhost:8080/logs', payload, params);

  // Check if the request was successful (HTTP 202 Accepted)
  check(res, {
    'is status 202': (r) => r.status === 202,
  });

  // Add a short sleep to simulate more realistic traffic patterns
  sleep(1);
}
```

## 3. Running Different Test Scenarios

### Scenario 1: Basic Load Test

This test simulates a steady load of 10 concurrent users (Virtual Users or VUs) for 30 seconds.

**Command:**

```bash
k6 run --vus 10 --duration 30s load-test.js
```

### Scenario 2: Stress Test (Ramping VUs)

This is the most valuable test. It helps you find the breaking point of your application by gradually increasing the load.

This script will start with 1 user, ramp up to 100 users over 1 minute, stay at 100 users for 2 minutes, and then ramp down.

**Update `load-test.js` to include stages:**

```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 100 }, // Ramp up to 100 users over 1 minute
    { duration: '2m', target: 100 }, // Stay at 100 users for 2 minutes
    { duration: '1m', target: 0 },   // Ramp down to 0 users
  ],
  thresholds: {
    'http_req_failed': ['rate<0.01'], // Fail the test if less than 1% of requests fail
    'http_req_duration': ['p(95)<200'], // 95% of requests must complete below 200ms
  },
};

const payload = JSON.stringify({
  level: 'error',
  message: 'Failed to connect to database',
  timestamp: new Date().toISOString(),
  service: 'payment-service',
});

const params = {
  headers: {
    'Content-Type': 'application/json',
    // 'Authorization': 'Bearer YOUR_SERAPH_API_KEY',
  },
};

export default function () {
  const res = http.post('http://localhost:8080/logs', payload, params);
  check(res, {
    'is status 202': (r) => r.status === 202,
  });
}
```

**Command:**

```bash
k6 run load-test.js
```

## 4. Analyzing the Results

When k6 finishes, it will print a summary of the results. Here's what to look for:

-   **`http_reqs`**: The total number of requests made. This is your primary throughput metric. Divide this by the duration to get the average requests per second (RPS).
-   **`http_req_duration`**: This shows the latency of your requests. Pay close attention to `p(95)` and `p(99)`. These percentiles tell you the response time for the slowest 5% and 1% of your requests, respectively. High values here indicate performance problems under load.
-   **`http_req_failed`**: The percentage of requests that failed. This should be as close to 0% as possible. Failures could be HTTP 5xx errors from Seraph or 429 "Too Many Requests" if you hit the rate limit.
-   **`vus`**: The number of active virtual users.

## 5. Monitoring Server-Side Performance

While running the load test, you must also monitor the Seraph agent's resource consumption on the server.

Use tools like `htop`, `top`, or `pidstat` to watch:

-   **CPU Usage**: Does the CPU usage spike to 100% and stay there? This could be a bottleneck.
-   **Memory Usage**: Is the memory usage stable, or does it grow continuously (indicating a potential memory leak)?

**Example using `pidstat` (if you know the Seraph PID):**

```bash
# Monitor CPU and Memory usage every 2 seconds for the given PID
pidstat -p <SERAPH_PID> -r -u 2
```

By combining the client-side metrics from k6 with server-side monitoring, you can get a complete picture of your application's performance and identify exactly where bottlenecks are.

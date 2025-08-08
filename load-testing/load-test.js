import http from 'k6/http';
import { check } from 'k6';

// This script is designed to stress test the Seraph agent's /logs endpoint.
// It ramps up the number of virtual users (VUs) to find the system's breaking point.

export const options = {
  stages: [
    { duration: '30s', target: 50 },    // Ramp up to 50 users over 30 seconds
    { duration: '1m', target: 50 },     // Stay at 50 users for 1 minute
    { duration: '30s', target: 200 },   // Ramp up to 200 users over 30 seconds
    { duration: '2m', target: 200 },    // Stay at 200 users for 2 minutes
    { duration: '30s', target: 500 },   // Ramp up to 500 users over 30 seconds
    { duration: '2m', target: 500 },    // Stay at 500 users for 2 minutes
    { duration: '1m', target: 0 },      // Ramp down to 0 users
  ],
  thresholds: {
    // The test will fail if more than 1% of requests return an error
    'http_req_failed': ['rate<0.01'],
    // 95% of requests must complete within 500ms
    'http_req_duration': ['p(95)<500'],
  },
};

const params = {
  headers: {
    'Content-Type': 'application/json',
    // If your Seraph instance requires an API key, uncomment and set the line below.
    // 'Authorization': `Bearer ${__ENV.SERAPH_API_KEY}`,
  },
};

export default function () {
  // A sample log payload to send. In a real test, you might want to
  // randomize this data or load it from a file to avoid caching effects.
  const payload = JSON.stringify({
    level: 'info',
    message: 'User logged in successfully',
    timestamp: new Date().toISOString(),
    service: 'auth-service',
    user_id: `user_${__VU}_${__ITER}`, // Use k6 variables to make each payload unique
  });

  // Send a POST request to the Seraph /logs endpoint
  const res = http.post('http://localhost:8080/logs', payload, params);

  // Verify that the response code is 202 (Accepted)
  check(res, {
    'status is 202': (r) => r.status === 202,
  });
}

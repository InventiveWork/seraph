
const express = require('express');
const app = express();
const port = 3000;

const normalLogs = [
  "User logged in successfully",
  "Data processed",
  "Payment completed",
  "File uploaded",
  "User profile updated",
];

const errorLogs = [
  "FATAL: Database connection failed: timeout expired",
  "CRITICAL: Memory leak detected in processing queue",
  "ERROR: Null pointer exception at com.example.Service:123",
  "FATAL: System shutting down due to critical failure",
];

const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const generateLog = () => {
  const isError = Math.random() < 0.2; // 20% chance of being an error
  if (isError) {
    console.log(JSON.stringify({
      level: 'error',
      message: getRandom(errorLogs),
      requestId: `req-${Math.random().toString(36).substring(2, 9)}`,
      status: 500,
    }));
  } else {
    console.log(JSON.stringify({
      level: 'info',
      message: getRandom(normalLogs),
      requestId: `req-${Math.random().toString(36).substring(2, 9)}`,
      status: 200,
    }));
  }
};

app.get('/', (req, res) => {
  // Use console.log to simulate structured logging (output is JSON string)
  console.log(JSON.stringify({
    level: 'info',
    message: getRandom(normalLogs),
    requestId: `req-${Math.random().toString(36).substring(2, 9)}`,
    status: 200,
  }));
  res.send('Logged a normal operation.');
});

app.get('/error', (req, res) => {
  console.log(JSON.stringify({
    level: 'error',
    message: getRandom(errorLogs),
    requestId: `req-${Math.random().toString(36).substring(2, 9)}`,
    status: 500,
  }));
  res.status(500).send('Triggered an error log!');
});

app.listen(port, () => {
  console.log(`Sample log generator app listening at http://localhost:${port}`);
  // Start generating logs automatically
  setInterval(generateLog, 15000); // Generate a log every 15 seconds
});

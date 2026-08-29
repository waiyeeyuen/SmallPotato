const [, , action, resource] = process.argv;

if (!action || !resource) {
  console.error(
    "Usage: node guardctl.mjs <action> <resource>",
  );

  process.exit(1);
}

const url = process.env.AGENTGUARD_URL;
const token = process.env.AGENTGUARD_TOKEN;

if (!url) {
  console.error("AGENTGUARD_URL is missing");
  process.exit(1);
}

if (!token) {
  console.error("AGENTGUARD_TOKEN is missing");
  process.exit(1);
}

const response = await fetch(
  `${url}/api/guard/action`,
  {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "X-Agent-Token": token,
    },

    body: JSON.stringify({
      action,
      resource,
    }),
  },
);

const body = await response.text();

console.log(body);

if (!response.ok) {
  process.exit(1);
}
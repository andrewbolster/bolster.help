// The page an authorization server sends you back to. It finishes the sign-in
// and returns you to where you started.

import { OAUTH_REDIRECT_URI } from "./config.js";
import { createConnections } from "./connections.js";

const sameOrigin = (target) => {
  try {
    return new URL(target, location.origin).origin === location.origin;
  } catch {
    return false;
  }
};

export async function finish(connections = createConnections({ redirectUri: OAUTH_REDIRECT_URI })) {
  const status = document.getElementById("status");
  try {
    const returnTo = await connections.complete(location.search);
    location.replace(sameOrigin(returnTo) ? returnTo : "/");
  } catch (err) {
    status.textContent = `Could not connect: ${err.message}`;
    document.getElementById("back").hidden = false;
  }
}

if (document.getElementById("status")) finish();

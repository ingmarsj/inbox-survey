// The secret that opens the results and statistics pages.
//
// It arrives once in a link (…#token=…; the fragment is never sent to any server) and is then
// remembered in this browser, so that the plain /stats/ address works afterwards.

const KEY = 'inbox-survey-results-token';

function fromUrl() {
  return new URLSearchParams(location.hash.slice(1)).get('token') ?? new URLSearchParams(location.search).get('token') ?? '';
}

function stored() {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function getToken() {
  return fromUrl() || stored();
}

/** Remember a token that worked, and take it out of the address bar. */
export function rememberToken(token) {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    return; // no storage: leave the link as it is so a reload still works
  }
  if (fromUrl()) history.replaceState(null, '', location.pathname);
}

/** Forget a token the server rejected. */
export function forgetToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}

/* Tiny fetch wrapper used by app.js. All endpoints return JSON; errors are
 * normalized into thrown Error objects carrying the server's message. */
const Api = (() => {
  // Invoked when a request fails because the session is missing/expired, so the
  // UI can drop back to the login gate.
  let unauthorizedHandler = null;

  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const msg = data && data.error ? data.error : `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.code;
      err.data = data;
      // Only auth-session failures trigger the gate — not "not connected" (which
      // is also a 401 but carries no AUTH_* code).
      if (res.status === 401 && (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_INVALID') && unauthorizedHandler) {
        unauthorizedHandler();
      }
      throw err;
    }
    return data;
  }

  // Encode each path segment so db/collection/user names with special
  // characters are transmitted safely.
  function path(...segments) {
    return '/' + segments.map((s) => encodeURIComponent(s)).join('/');
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url, body) => request('DELETE', url, body),
    path,
    onUnauthorized: (fn) => {
      unauthorizedHandler = fn;
    },
  };
})();

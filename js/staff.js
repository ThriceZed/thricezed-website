/* ============================================================================
   Staff file access gate.

   Passwords are stored as SHA-256 hashes rather than plain text so they are
   not sitting in the open in a public repo. Be clear-eyed about what this is:
   the check runs in the browser, so anyone determined can bypass it. It keeps
   casual visitors out of the page, nothing more. Never put anything private
   in the shared folder.
   ========================================================================== */
(function () {
  'use strict';

  var HASHES = [
    '07f5a54cf7516da86a04456eedc11f991a3b86a3c966620b8a0da7fbfa5a9f6c',
    'b130bcf124fc6a15356df6e25ad7bdf3f3ede7ab6bd6bea90088fbe366810ecd',
    'a8d055f68c66bbfba423c4d946475d1ab984806dfac38ff568b3048f05cabeb1'
  ];

  var SESSION_KEY = 'tz-staff-ok';

  // Folder listing comes from the public GitHub contents API so that files
  // appear on their own as soon as they land in staff-files, with no manifest
  // to keep in sync. Downloads themselves are served straight off the website.
  var LIST_API = 'https://api.github.com/repos/ThriceZed/thricezed-website/contents/staff-files';
  var SKIP = ['readme.md', '.gitkeep', '.ds_store'];

  var loginPanel = document.getElementById('login-panel');
  var filesPanel = document.getElementById('files-panel');
  var form = document.getElementById('login-form');
  var input = document.getElementById('pw');
  var errorEl = document.getElementById('login-error');
  var signout = document.getElementById('signout');
  var fileList = document.getElementById('file-list');

  if (!loginPanel || !filesPanel) return;

  var filesLoaded = false;

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
  }

  function setStatus(text) {
    fileList.innerHTML = '';
    var li = document.createElement('li');
    li.className = 'file-status';
    li.textContent = text;
    fileList.appendChild(li);
  }

  function renderFiles(items) {
    fileList.innerHTML = '';
    items.forEach(function (item) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'file-row';
      // Same-origin path, so the browser downloads it straight from the site.
      a.href = 'staff-files/' + encodeURIComponent(item.name);
      a.setAttribute('download', item.name);

      var meta = document.createElement('div');
      meta.className = 'file-meta';
      var name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = item.name;
      var size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatSize(item.size);
      meta.appendChild(name);
      meta.appendChild(size);

      var get = document.createElement('span');
      get.className = 'file-get';
      get.textContent = 'Download';

      a.appendChild(meta);
      a.appendChild(get);
      li.appendChild(a);
      fileList.appendChild(li);
    });
  }

  async function loadFiles() {
    if (filesLoaded || !fileList) return;
    filesLoaded = true;
    setStatus('Loading files...');
    try {
      var res = await fetch(LIST_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('status ' + res.status);
      var data = await res.json();
      var files = (Array.isArray(data) ? data : []).filter(function (item) {
        return item.type === 'file' && SKIP.indexOf(item.name.toLowerCase()) === -1;
      });
      files.sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!files.length) { setStatus('No files here yet.'); return; }
      renderFiles(files);
    } catch (err) {
      filesLoaded = false;
      setStatus('Could not load the file list. Try again in a moment.');
    }
  }

  function showFiles() {
    loginPanel.classList.add('hidden');
    filesPanel.classList.remove('hidden');
    loadFiles();
  }

  function showLogin() {
    filesPanel.classList.add('hidden');
    loginPanel.classList.remove('hidden');
    input.value = '';
    errorEl.textContent = '';
  }

  async function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map
      .call(new Uint8Array(digest), function (b) {
        return b.toString(16).padStart(2, '0');
      })
      .join('');
  }

  // Stay signed in for this browser tab only.
  try {
    if (sessionStorage.getItem(SESSION_KEY) === '1') showFiles();
  } catch (e) { /* private mode, just show the login */ }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var value = input.value.trim();
    if (!value) { errorEl.textContent = 'Enter your password.'; return; }

    if (!window.crypto || !crypto.subtle) {
      errorEl.textContent = 'This page needs a secure (https) connection to sign in.';
      return;
    }

    errorEl.textContent = '';
    var hash;
    try {
      hash = await sha256Hex(value);
    } catch (err) {
      errorEl.textContent = 'Could not check that password. Try reloading the page.';
      return;
    }

    if (HASHES.indexOf(hash) >= 0) {
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) {}
      showFiles();
    } else {
      errorEl.textContent = 'That password did not work.';
      input.select();
    }
  });

  if (signout) {
    signout.addEventListener('click', function () {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
      showLogin();
    });
  }
})();

/**
 * compositeFingerprint.js
 * Generate a composite browser fingerprint from several stable signals
 * and compare two fingerprints with a similarity score (0 – 1).
 *
 * ▶ Works in both browser and Node. In Node the "unstable" browser‑only
 *   signals fall back to "unavailable".
 * ▶ The compare() function now accepts:
 *     • Full fingerprint objects (with .id and .components)
 *     • Plain hash strings (compares equality only)
 *     • Mixed inputs (object vs string)
 *
 * ------------------------------------------------------------
 *  Browser usage
 *    const fp = await CompositeFingerprint.generate();
 *    console.log(fp.id, fp.components);
 *
 *  Node CLI
 *    node compositeFingerprint.js   # prints id + JSON components
 * ------------------------------------------------------------
 */

const CompositeFingerprint = (() => {
  /******************** UTILITIES ********************/
  const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
  const nodeCrypto = !isBrowser ? require('crypto') : null;
  const nodeOs     = !isBrowser ? require('os')     : null;

  // ArrayBuffer → hex
  const buf2hex = buffer => [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');

  // SHA‑256 (browser or Node)
  const hashString = async str => {
    if (isBrowser && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return buf2hex(buf);
    }
    return nodeCrypto.createHash('sha256').update(str).digest('hex');
  };

  /**************** COMPONENT COLLECTORS ****************/
  // 🅰️ Generate a stable salt in Normal mode, new one in Private
  const getStorageSalt = () => {
    if (!isBrowser) return 'unavailable';
    try {
      const KEY = '__fp_salt_v1';
      let salt = localStorage.getItem(KEY);
      if (!salt) {
        salt = crypto.getRandomValues(new Uint32Array(4)).join('-');
        localStorage.setItem(KEY, salt);
      }
      return salt;
    } catch {
      return 'unavailable';
    }
  };

  // 🅱️ Detect Safari Private Mode based on storage quota (≈ 50 MB)
  const detectPrivateMode = () => new Promise(resolve => {
    if (!isBrowser || !indexedDB) return resolve(false);

    try {
      const db = indexedDB.open('fp-test');
      db.onerror = () => resolve(true);
      db.onsuccess = () => {
        navigator.storage.estimate()
          .then(({ quota }) => resolve(quota && quota < 150_000_000))
          .catch(() => resolve(false));
        db.result.close();
        indexedDB.deleteDatabase('fp-test');
      };
    } catch {
      resolve(true);
    }
  });

  const getAudioHash = async () => {
    if (!isBrowser) return 'unavailable';
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const analyser = ctx.createAnalyser();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      osc.connect(analyser);
      analyser.connect(ctx.destination);
      osc.start(0);
      const samples = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(samples);
      osc.stop();
      ctx.close();
      return await hashString(samples.toString());
    } catch {
      return 'unavailable';
    }
  };

  const getDRMHash = async () => {
    if (!isBrowser) return 'unavailable';
    try {
      if (!('requestMediaKeySystemAccess' in navigator)) return 'unsupported';
      const cfg = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4' }] }];
      const ks  = ['com.apple.fps.1_0', 'com.widevine.alpha'];
      const res = [];
      for (const id of ks) {
        try {
          const access = await navigator.requestMediaKeySystemAccess(id, cfg);
          res.push(`${id}:granted:${access.keySystem}`);
        } catch {
          res.push(`${id}:denied`);
        }
      }
      return await hashString(res.join('|'));
    } catch {
      return 'unavailable';
    }
  };

  const getCanvasHash = async () => {
    if (!isBrowser) return 'unavailable';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 50;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069'; ctx.fillText('TraQR Canvas FP', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('TraQR Canvas FP', 4, 17);
      return await hashString(canvas.toDataURL());
    } catch {
      return 'unavailable';
    }
  };

  const getDeviceInfo = () => {
    if (isBrowser) {
      return {
        userAgent: navigator.userAgent,
        screenRes: `${screen.width}x${screen.height}`,
        deviceMemory: navigator.deviceMemory || 'unknown',
        hardwareConcurrency: navigator.hardwareConcurrency || 'unknown'
      };
    }
    return {
      userAgent: `Node/${process.version}`,
      screenRes: 'N/A',
      deviceMemory: `${Math.round(nodeOs.totalmem() / (1024 ** 3))} GB`,
      hardwareConcurrency: nodeOs.cpus().length
    };
  };

  const getLocaleInfo = () => {
    if (isBrowser) {
      return {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
        languages: navigator.languages
      };
    }
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: process.env.LANG || 'unknown',
      languages: []
    };
  };

  /**************** PUBLIC API ****************/
  const generate = async () => {
    const [audioHash, drmHash, canvasHash] = await Promise.all([
      getAudioHash(),
      getDRMHash(),
      getCanvasHash()
    ]);

    const storageSalt = getStorageSalt();              // 🅰️ Get salt
    const isPrivate = await detectPrivateMode();       // 🅱️ Detect Private Mode

    const components = {
      audioHash,
      drmHash,
      canvasHash,
      storageSalt,             // 🅰️ Added to components
      privateFlag: isPrivate,  // 🅱️ Added to components
      deviceInfo: getDeviceInfo(),
      localeInfo: getLocaleInfo()
    };

    const id = await hashString(JSON.stringify(components));
    return { id, components };
  };


  /**
   * Compare two fingerprints or IDs.
   * Accepts:
   *   – Full objects { id, components }
   *   – Plain strings (treated as IDs)
   * Returns similarity score 0–1.
   */
    /**
   * Compare two fingerprints / IDs / JSON strings.
   * Robust handling:
   *   • Plain SHA‑256 strings → equality check
   *   • JSON strings (full fp or components‑only) → parsed & compared
   *   • Objects with {id, components}
   *   • Objects that ARE components (audioHash, drmHash …)
   * Returns float 0‑1 (1 = identical on all evaluated fields)
   */
const compare = (left, right) => {
  const normalise = (val) => {
    if (val && typeof val === 'object') {
      if (val.components) return val.components;
      if (val.audioHash)  return val;
    }

    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        return normalise(parsed);
      } catch {
        return { __idOnly: val };
      }
    }

    return {};
  };

  const a = normalise(left);
  const b = normalise(right);

  // Quick check: are objects fully normalized?
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    console.warn("Normalization failed", { a, b });
    return 0;
  }

  if (a.__idOnly || b.__idOnly) {
    return (a.__idOnly && b.__idOnly && a.__idOnly === b.__idOnly) ? 1 : 0;
  }

  // Debug print
  console.log("Comparing:", { a, b });

  // Weights
  const weights = {
    audioHash: 2,
    drmHash: 2,
    canvasHash: 1,
    userAgent: 2,
    screenRes: 1,
    deviceMemory: 1,
    hardwareConcurrency: 1,
    timezone: 1,
    language: 1,
    languages0: 1
  };

  let score = 0;
  let total = 0;

  const add = (valA, valB, key) => {
    const w = weights[key] || 1;
    total += w;
    if (valA === valB) score += w;
    else {
      console.log(`Mismatch in ${key}:`, valA, valB);
    }
  };

  add(a.audioHash,  b.audioHash,  'audioHash');
  add(a.drmHash,    b.drmHash,    'drmHash');
  add(a.canvasHash, b.canvasHash, 'canvasHash');

  const dA = a.deviceInfo || {}, dB = b.deviceInfo || {};
  add(dA.userAgent,           dB.userAgent,            'userAgent');
  add(dA.screenRes,           dB.screenRes,            'screenRes');
  add(dA.deviceMemory,        dB.deviceMemory,         'deviceMemory');
  add(dA.hardwareConcurrency, dB.hardwareConcurrency,  'hardwareConcurrency');

  const lA = a.localeInfo || {}, lB = b.localeInfo || {};
  add(lA.timezone,  lB.timezone,  'timezone');
  add(lA.language,  lB.language,  'language');
  add(lA.languages?.[0], lB.languages?.[0], 'languages0');

  return total ? score / total : 0;
};

  return { generate, compare };
})();

/**************** EXPORTS ****************/
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = CompositeFingerprint;
} else {
  window.CompositeFingerprint = CompositeFingerprint;
}

/**************** CLI (Node) ****************/
if (typeof require !== 'undefined' && require.main === module) {
  (async () => {
    const fp = await CompositeFingerprint.generate();
    console.log('Fingerprint ID:', fp.id);
    console.log('Components:', JSON.stringify(fp.components, null, 2));
  })();
}

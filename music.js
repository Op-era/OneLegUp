// Shared music player — persists across same-tab page navigations via sessionStorage
(function () {
  const PLAYLIST = [
    { src: 'music/Butterflies.mp3', label: 'Butterflies' },
    { src: 'music/RingMyBell.mp3',  label: 'Ring My Bell' },
    { src: 'music/First Time.mp3',  label: 'First Time' }
  ];
  const KEY = 'olu_music';
  let audio, bar, label, iconPause, iconPlay;
  let trackIndex = 0;

  function readState() {
    try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; }
  }
  function writeState() {
    if (!audio) return;
    sessionStorage.setItem(KEY, JSON.stringify({
      idx: trackIndex, time: audio.currentTime,
      vol: audio.volume, play: !audio.paused
    }));
  }
  function loadTrack(idx, seekTo) {
    trackIndex = ((idx % PLAYLIST.length) + PLAYLIST.length) % PLAYLIST.length;
    audio.src  = PLAYLIST[trackIndex].src;
    if (label) label.textContent = PLAYLIST[trackIndex].label;
    if (seekTo != null) audio.currentTime = seekTo;
  }
  function syncUI() {
    if (!iconPause || !iconPlay) return;
    iconPause.style.display = audio.paused ? 'none' : '';
    iconPlay.style.display  = audio.paused ? '' : 'none';
  }

  function injectStyles() {
    if (document.getElementById('olu-music-styles')) return;
    const s = document.createElement('style');
    s.id = 'olu-music-styles';
    s.textContent = `
      #music-bar{position:fixed;bottom:16px;right:16px;z-index:500;display:flex;align-items:center;gap:6px;background:rgba(10,25,35,0.82);border:1px solid rgba(243,198,117,0.25);border-radius:30px;padding:6px 12px 6px 8px;backdrop-filter:blur(10px);box-shadow:0 4px 20px rgba(0,0,0,0.4);}
      #music-toggle{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#f3c675,#ec8b57);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.2s;flex-shrink:0;}
      #music-toggle:hover{transform:scale(1.1);}
      #music-toggle svg{width:16px;height:16px;fill:#152d35;}
      .olu-nav-btn{width:26px;height:26px;border-radius:50%;background:rgba(243,198,117,0.12);border:1px solid rgba(243,198,117,0.25);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s,transform 0.2s;flex-shrink:0;}
      .olu-nav-btn:hover{background:rgba(243,198,117,0.25);transform:scale(1.1);}
      .olu-nav-btn svg{width:13px;height:13px;fill:rgba(243,198,117,0.8);}
      #music-label{font-size:0.72rem;letter-spacing:0.06em;color:rgba(243,198,117,0.75);white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;font-family:'Poppins',sans-serif;}
    `;
    document.head.appendChild(s);
  }

  function injectHTML() {
    if (!document.getElementById('site-audio')) {
      const a = document.createElement('audio');
      a.id = 'site-audio'; a.preload = 'auto';
      document.body.appendChild(a);
    }
    if (!document.getElementById('music-bar')) {
      const div = document.createElement('div');
      div.id = 'music-bar'; div.style.display = 'none';
      div.innerHTML = `
        <button class="olu-nav-btn" id="music-prev" aria-label="Previous">
          <svg viewBox="0 0 24 24"><polygon points="19,5 9,12 19,19"/><rect x="5" y="5" width="3" height="14"/></svg>
        </button>
        <button id="music-toggle" aria-label="Play/Pause">
          <svg id="icon-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          <svg id="icon-play"  viewBox="0 0 24 24" style="display:none"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
        <button class="olu-nav-btn" id="music-next" aria-label="Next">
          <svg viewBox="0 0 24 24"><polygon points="5,5 15,12 5,19"/><rect x="16" y="5" width="3" height="14"/></svg>
        </button>
        <span id="music-label"></span>`;
      document.body.appendChild(div);
    }
  }

  function init() {
    injectStyles();
    injectHTML();

    audio     = document.getElementById('site-audio');
    bar       = document.getElementById('music-bar');
    label     = document.getElementById('music-label');
    iconPause = document.getElementById('icon-pause');
    iconPlay  = document.getElementById('icon-play');

    const s = readState();
    if (s && s.play) {
      loadTrack(s.idx, s.time);
      audio.volume = s.vol ?? 1;
      bar.style.display = 'flex';
      audio.play().catch(() => {});
    }

    audio.addEventListener('ended', () => { loadTrack(trackIndex + 1); audio.play(); });
    audio.addEventListener('play',  syncUI);
    audio.addEventListener('pause', syncUI);

    window.addEventListener('beforeunload', writeState);
    setInterval(writeState, 3000);

    document.getElementById('music-prev').addEventListener('click', () => {
      loadTrack(trackIndex - 1); if (!audio.paused) audio.play(); syncUI();
    });
    document.getElementById('music-next').addEventListener('click', () => {
      loadTrack(trackIndex + 1); if (!audio.paused) audio.play(); syncUI();
    });
    document.getElementById('music-toggle').addEventListener('click', () => {
      audio.paused ? audio.play() : audio.pause();
    });
  }

  // Called by landing page after user presses play
  window.OLUMusic = {
    start() {
      if (!audio) return;
      loadTrack(0, 0);
      audio.volume = 0;
      audio.play().catch(() => {});
      let v = 0;
      const fi = setInterval(() => {
        v = Math.min(1, v + 0.04); audio.volume = v;
        if (v >= 1) clearInterval(fi);
      }, 80);
      bar.style.display = 'flex';
      sessionStorage.setItem(KEY, JSON.stringify({ idx: 0, time: 0, vol: 1, play: true }));
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

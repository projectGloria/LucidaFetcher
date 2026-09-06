async function renderCompletedTab() {
  const container = document.getElementById('completed');
  if (!container) return;
  
  const manifest = await ipcRenderer.invoke('manifest-get');
  const items = Object.values(manifest || {});
  if (items.length === 0) {
    container.innerHTML = '<div class="empty"><h3>No completed downloads yet</h3></div>';
    return;
  }
  
  container.innerHTML = '<div style="padding: 1rem;"><div id="completed-list" class="group-download-items"></div></div>';
  const list = document.getElementById('completed-list');
  
  // Sort by some criteria if timestamp was saved, but manifest has { url, format, bitDepth, sampleRate, ... }
  // We can just show them all.
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'download-item';
    
    // We don't have artwork in manifest, just show a placeholder or name
    const info = document.createElement('div');
    info.className = 'download-info';
    info.style.padding = '10px';
    
    const nameEl = document.createElement('div');
    nameEl.className = 'download-name';
    nameEl.innerText = item.url.split('/').pop() || item.url;
    
    const descEl = document.createElement('div');
    descEl.style.fontSize = '0.8em';
    descEl.style.color = 'var(--text-secondary)';
    descEl.innerText = `${item.format} | ${item.bitDepth || ''} ${item.sampleRate ? (item.sampleRate/1000)+'kHz' : ''}`;
    
    info.appendChild(nameEl);
    info.appendChild(descEl);
    row.appendChild(info);
    
    const btn = document.createElement('button');
    btn.className = 'download-btn';
    btn.innerText = 'Re-download';
    btn.onclick = () => {
      // Trigger a search/download for this URL again
      searchInput.value = item.url;
      performSearch();
    };
    row.appendChild(btn);
    
    list.appendChild(row);
  });
}

// Call this periodically or when switching tabs
document.querySelector('[data-tab="completed"]')?.addEventListener('click', renderCompletedTab);

async function renderSavedProfiles() {
  const profiles = await ipcRenderer.invoke('profiles-get');
  const list = document.getElementById('saved-profiles-list');
  const section = document.getElementById('saved-profiles-section');
  if (!list || !section) return;
  
  if (!profiles || profiles.length === 0) {
    section.style.display = 'none';
    return;
  }
  
  section.style.display = 'block';
  list.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.innerHTML = `<span class="nav-label-text">${p.user} (${p.service})</span>`;
    btn.onclick = () => {
      searchInput.value = p.url;
      performSearch();
    };
    list.appendChild(btn);
  });
}
renderSavedProfiles();

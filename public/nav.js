(async () => {
  const header = document.querySelector('header');
  if (!header) return;
  try {
    const html = await (await fetch('nav.html', { cache: 'no-store' })).text();
    header.innerHTML = html;

    // ⬇️ sposta sidebar + overlay FUORI dall'header (nel <body>)
    const sbFromHeader = header.querySelector('#sidebar');
    const ovFromHeader = header.querySelector('#overlay');
    if (sbFromHeader) document.body.appendChild(sbFromHeader);
    if (ovFromHeader) document.body.appendChild(ovFromHeader);

    // evidenzia pagina corrente
    const here = location.pathname.split('/').pop() || 'index.html';
    [...document.querySelectorAll('#sb-links a')].forEach(a => {
      const href = a.getAttribute('href');
      if (href === here) a.innerHTML = `<b>${a.textContent}</b>`;
    });

    // sidebar toggle (con overlay blur + blocco scroll)
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    const btn = document.getElementById('btnMenu');

    function openMenu(){
      sidebar.classList.add('open');
      overlay.classList.add('show');
      document.body.classList.add('no-scroll');   // blocca lo scroll del contenuto sotto
    }
    function closeMenu(){
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
      document.body.classList.remove('no-scroll'); // riabilita lo scroll
    }

    btn.addEventListener('click', openMenu);
    overlay.addEventListener('click', closeMenu);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

    // ricerca globale (debounced)
    const input = document.getElementById('globalSearch');
    const results = document.getElementById('searchResults');
    let t;
    function render(items){
      if (!items || !items.length){ results.style.display='none'; results.innerHTML=''; return; }
      results.innerHTML = items.map(it=>(
        `<a href="${it.url}">
          <span class="tag">${it.kind}</span>
          <span>${it.label}</span>
          ${it.sub?`<small class="muted" style="margin-left:auto">${it.sub}</small>`:''}
        </a>`
      )).join('');
      results.style.display='block';
    }
    input.addEventListener('input', async ()=>{
      clearTimeout(t);
      const q = input.value.trim();
      if (!q){ render([]); return; }
      t = setTimeout(async ()=>{
        try{
          const r = await fetch('/api/search?q='+encodeURIComponent(q));
          const j = await r.json();
          render(j);
        }catch{ render([]); }
      }, 180);
    });
    input.addEventListener('blur', ()=> setTimeout(()=>render([]), 200));
  } catch (e) {
    console.warn('nav load failed:', e);
  }
})();

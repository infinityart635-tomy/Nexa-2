const $ = (id)=>document.getElementById(id);

    function money(n, currency){
      const v = Number(n||0);
      try{
        return new Intl.NumberFormat("es-AR", { style:"currency", currency: currency || "ARS", maximumFractionDigits: 0 }).format(v);
      }catch{ return "$" + Math.round(v); }
    }

    async function boot(){
      // quién soy
      try{
        const me = await fetch("/api/auth/me", {cache:"no-store"}).then(r=>r.json());
        $("me").textContent = `Sesión: ${me.role}${me.name ? " · " + me.name : ""}`;
      }catch{ $("me").textContent = "Sesión: —"; }

      // info de servidor (URLs)
      let info = null;
      try{ info = await fetch("/api/info", {cache:"no-store"}).then(r=>r.json()); }catch{}
      const preferred = (info && info.preferred) ? info.preferred : location.origin;
      $("pref").textContent = preferred.replace(/^https?:\/\//,'');

      const menuUrl = preferred + "/menu.html";
      const mozoUrl = preferred + "/login.html?role=mozo&next=/mozo.html";

      $("urlMenu").textContent = menuUrl;
      $("urlMozo").textContent = mozoUrl;

      $("qrMenu").src = "/qr.png?u=" + encodeURIComponent(menuUrl);
      $("qrMozo").src = "/qr.png?u=" + encodeURIComponent(mozoUrl);

      // KPIs mes
      try{
        const stats = await fetch("/api/stats?preset=month", {cache:"no-store"}).then(r=>r.json());
        const cur = (info && info.currency) ? info.currency : ((stats && stats.currency) || "ARS");
        $("kTotal").textContent = money(stats.totals.total, cur);
        $("kProfit").textContent = money(stats.totals.profit, cur);
        $("kTickets").textContent = String(stats.totals.salesCount || 0);
        $("kAvg").textContent = money(stats.totals.avgTicket, cur);
      }catch(e){
        $("kTotal").textContent = "—";
        $("kProfit").textContent = "—";
        $("kTickets").textContent = "—";
        $("kAvg").textContent = "—";
      }
    }

    $("btnLogout").addEventListener("click", async ()=>{
      try{ await fetch("/api/auth/logout"); }catch(e){}
      location.href = "/login.html";
    });

    boot();
  </script>
  <script src="/app.js">

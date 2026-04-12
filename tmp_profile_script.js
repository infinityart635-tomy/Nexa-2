
    const $ = (id) => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const next = params.get("next") || sessionStorage.getItem("nexa_next") || "";
    const state = {
      me: null,
      profile: null,
      restaurantState: null,
      passwordVerified: false,
      deleteRestaurantId: "",
      trashedRestaurants: [],
      branchRestaurantId: "",
      branchRestaurantRole: "",
      branchRestaurantName: "",
      branches: [],
    };
    if (next) sessionStorage.setItem("nexa_next", next);

    function loginUrl() {
      return next ? `/login.html?next=${encodeURIComponent(next)}` : "/login.html";
    }

    function defaultPathForRole(role) {
      const nextPath = String(next || "");
      if (role === "mozo") {
        return nextPath && nextPath.toLowerCase().startsWith("/mozo") ? nextPath : "/mozo.html";
      }
      return nextPath || "/salon_pc.html";
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function restaurantAvatarText(value) {
      const text = String(value || "").trim();
      const parts = text.split(/\s+/).filter(Boolean).slice(0, 2);
      if (parts.length) return parts.map(part => part[0]).join("").toUpperCase();
      return "NX";
    }


    function roleText(role, restaurantRole, restaurantName) {
      if (!role || role === "account") return "Cuenta";
      const label = role === "admin" ? "Restaurante" : "Mozo";
      return restaurantName ? `${label} en ${restaurantName}` : label;
    }

    function message(elId, text, kind) {
      const el = $(elId);
      if (!el) return;
      el.textContent = text || "";
      el.className = "msgBox" + (text ? " show" : "") + (kind ? ` ${kind}` : "");
    }

    function renderPasswordSteps() {
      $("passwordVerifyStep").classList.toggle("active", !state.passwordVerified);
      $("passwordChangeStep").classList.toggle("active", !!state.passwordVerified);
    }

    function resetPasswordFlow() {
      state.passwordVerified = false;
      $("passwordRecoveryAnswer").value = "";
      $("passwordNew").value = "";
      $("passwordConfirm").value = "";
      renderPasswordSteps();
    }

    function updateCreateRestaurantPreview() {
      const value = ($("createRestaurantName") && $("createRestaurantName").value || "").trim();
      $("createRestaurantPreview").textContent = value || "Tu restaurante";
    }

    function renderBranchList() {
      const box = $("branchList");
      const items = state.branches || [];
      if (!items.length) {
        box.innerHTML = '<div class="emptyState">Todavia no hay sucursales. Crea la primera para entrar.</div>';
        return;
      }
      box.innerHTML = items.map((item) => `
        <div class="branchOption">
          <div>
            <div class="branchOptionTitle">${escapeHtml(item.name || "Sucursal")}</div>
            <div class="itemSub">Restaurante: ${escapeHtml(state.branchRestaurantName || "Restaurante")}</div>
          </div>
          <button class="btn primary" type="button" onclick="selectBranchAndContinue('${escapeHtml(item.id)}')">Entrar</button>
        </div>
      `).join("");
    }

    async function openBranchPanel(restaurantId, role, restaurantName) {
      state.branchRestaurantId = String(restaurantId || "");
      state.branchRestaurantRole = String(role || "admin");
      state.branchRestaurantName = String(restaurantName || "Restaurante");
      $("branchPanelTitle").textContent = `Sucursal de ${state.branchRestaurantName}`;
      message("branchMsg", "", "");
      const data = await api(`/api/restaurants/branches?restaurantId=${encodeURIComponent(state.branchRestaurantId)}`);
      state.branches = data.branches || [];
      renderBranchList();
      setMainPanel("branch");
    }

    function openCreateBranchModal() {
      $("branchRestaurantNameLabel").textContent = state.branchRestaurantName || "este restaurante";
      $("branchName").value = "";
      message("branchCreateMsg", "", "");
      $("branchCreateModal").classList.add("open");
      $("branchCreateModal").setAttribute("aria-hidden", "false");
      $("branchName").focus();
    }

    function closeCreateBranchModal() {
      $("branchCreateModal").classList.remove("open");
      $("branchCreateModal").setAttribute("aria-hidden", "true");
      $("branchName").value = "";
      message("branchCreateMsg", "", "");
    }

    function toggleRestaurantDelete(restaurantId) {
      if (state.deleteRestaurantId === restaurantId) {
        closeDeleteRestaurantModal();
        return;
      }
      const items = ((state.profile && state.profile.ownedRestaurants) || []);
      const restaurant = items.find((item) => String(item.id || "") === String(restaurantId || ""));
      state.deleteRestaurantId = String(restaurantId || "");
      $("deleteRestaurantNameLabel").textContent = restaurant && restaurant.name ? restaurant.name : "el nombre del restaurante";
      $("deleteRestaurantConfirmInput").value = "";
      message("deleteRestaurantMsg", "", "");
      $("deleteRestaurantModal").classList.add("open");
      $("deleteRestaurantModal").setAttribute("aria-hidden", "false");
      $("deleteRestaurantConfirmInput").focus();
    }

    function closeDeleteRestaurantModal() {
      state.deleteRestaurantId = "";
      $("deleteRestaurantModal").classList.remove("open");
      $("deleteRestaurantModal").setAttribute("aria-hidden", "true");
      $("deleteRestaurantConfirmInput").value = "";
      message("deleteRestaurantMsg", "", "");
    }

    function setMainPanel(panelName) {
      document.querySelectorAll(".profilePanel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === panelName);
      });
      $("btnViewAccount").classList.toggle("active", panelName === "account");
      $("btnViewFirstSteps").classList.toggle("active", panelName === "firstSteps");
      $("btnViewRestaurants").classList.toggle("active", panelName === "restaurants" || panelName === "createRestaurant" || panelName === "branch");
      $("btnViewTrash").classList.toggle("active", panelName === "trash");
      message("passwordMsg", "", "");
      if (panelName === "password") resetPasswordFlow();
      if (panelName === "createRestaurant") {
        updateCreateRestaurantPreview();
        message("createMsg", "", "");
      }
    }

    function errorText(error) {
      if (error === "missing_restaurant_name") return "Escribe un nombre para el restaurante.";
      if (error === "restaurant_name_taken") return "Ya existe un restaurante con ese nombre.";
      if (error === "restaurant_not_found") return "No se encontro ese restaurante.";
      if (error === "already_owner") return "Ese restaurante ya es tuyo.";
      if (error === "already_member") return "Ya tienes acceso activo como mozo en ese restaurante.";
      if (error === "request_pending") return "Ya hay una solicitud pendiente para ese restaurante.";
      if (error === "request_not_found") return "No se encontro la solicitud.";
      if (error === "invalid_request") return "La solicitud ya no esta pendiente.";
      if (error === "forbidden") return "No tienes permiso para entrar con ese rol.";
      if (error === "bad_role") return "Ese rol no es valido para entrar.";
      if (error === "missing_name") return "Escribe tu nombre.";
      if (error === "missing_username") return "Escribe un usuario.";
      if (error === "missing_email") return "Escribe un mail.";
      if (error === "missing_security_answer") return "Completa la respuesta de seguridad.";
      if (error === "missing_branch_name") return "Escribe un nombre para la sucursal.";
      if (error === "branch_name_taken") return "Ya existe una sucursal con ese nombre.";
      if (error === "branch_not_found") return "No se encontro esa sucursal.";
      if (error === "missing_restaurant_confirmation") return "Escribe el nombre del restaurante para confirmar.";
      if (error === "restaurant_confirmation_mismatch") return "El nombre no coincide.";
      if (error === "restaurant_already_trashed") return "Ese restaurante ya esta en la papelera.";
      if (error === "restaurant_not_trashed") return "Ese restaurante no esta en la papelera.";
      if (error === "weak_password") return "Usa una contrasena de al menos 4 caracteres.";
      if (error === "invalid_current_password") return "La contrasena actual no coincide.";
      if (error === "invalid_security_answer") return "La respuesta de seguridad no coincide.";
      if (error === "recovery_not_configured") return "Primero configura una pregunta y respuesta de seguridad.";
      if (error === "account_not_found") return "No se encontro la cuenta.";
      if (error === "username_taken") return "Ese usuario ya esta en uso.";
      if (error === "email_taken") return "Ese mail ya esta en uso.";
      if (error === "nothing_to_update") return "No hay cambios para guardar.";
      if (error === "unauthorized") return "Tu sesion no tiene permiso para esta accion.";
      return error ? `Error: ${error}` : "No se pudo completar la accion.";
    }

    async function api(path, options) {
      const res = await fetch(path, Object.assign({ cache: "no-store" }, options || {}));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data && data.error ? data.error : "request_failed");
        error.payload = data;
        throw error;
      }
      return data;
    }

    function fillAccountForm() {
      const user = state.profile && state.profile.user ? state.profile.user : {};
      const securityQuestion = (state.profile && state.profile.securityQuestion) || "";
      $("accountUsername").value = user.username || "";
      $("accountEmail").value = user.email || "";
      $("passwordRecoveryQuestion").value = securityQuestion || "No configurada";
      resetPasswordFlow();
    }

    function renderSummary() {
      const me = state.me || {};
      const user = state.profile && state.profile.user ? state.profile.user : {};
      const trashCount = (state.trashedRestaurants || []).length || 0;
      document.body.setAttribute("data-restaurant-active", (me.restaurantId && (me.role === "admin" || me.role === "mozo")) ? "1" : "0");
      $("userTitle").textContent = user.name || user.username || "Mi cuenta";
      $("userSub").textContent = me.restaurantName
        ? roleText(me.role, me.restaurantRole, me.restaurantName)
        : "Cuenta";
      $("trashCountBadge").textContent = trashCount ? String(trashCount) : "";
      $("trashCountBadge").classList.toggle("show", trashCount > 0);
    }

    function renderOwnedRestaurants() {
      const box = $("ownedRestaurants");
      const ownedItems = ((state.profile && state.profile.ownedRestaurants) || []).map((item) => ({ ...item, viewRole: "owner" }));
      const mozoItems = ((state.profile && state.profile.mozoRestaurants) || [])
        .filter((item) => item && item.membership && item.membership.status === "active")
        .map((item) => ({ ...item, viewRole: "mozo" }));
      const items = [...ownedItems, ...mozoItems];
      if (!items.length) {
        box.innerHTML = '<div class="emptyState">Sin restaurantes.</div>';
        return;
      }
      box.innerHTML = items.map((item) => {
        const commerceName = escapeHtml(item.name || "Comercio");
        const ownerName = escapeHtml(item.ownerName || state.profile.user.name || "");
        const avatar = escapeHtml(restaurantAvatarText(item.name || ""));
        const isOwner = item.viewRole === "owner";
        const accessLabel = isOwner ? "Administrador" : "Mozo";
        const actionRole = isOwner ? "admin" : "mozo";
        return `
          <div class="itemCard ownedCommerceCard">
            <div class="ownedCommerceHeader">
              <div class="ownedCommerceAvatar">${avatar}</div>
              <div>
                <div class="ownedCommerceEyebrow">${isOwner ? "Restaurante propio" : "Restaurante asignado"}</div>
                <div class="ownedCommerceTitle">${commerceName}</div>
                <div class="itemSub">Dueno: ${ownerName}</div>
              </div>
              <div class="itemMeta">
                <span class="tag ok">${accessLabel}</span>
              </div>
            </div>

            <div class="ownedCommerceMeta">
              <div class="ownedCommerceStat">
                <span>Tipo</span>
                <strong>${isOwner ? "Propio" : "Equipo"}</strong>
              </div>
              <div class="ownedCommerceStat">
                <span>Acceso</span>
                <strong>${accessLabel}</strong>
              </div>
            </div>

            <div class="ownedCommerceActions">
              <button class="btn primary" type="button" onclick="enterRestaurant('${escapeHtml(item.id)}','${actionRole}')">${isOwner ? "Entrar como restaurante" : "Entrar como mozo"}</button>
              ${isOwner ? `<button class="btn restaurantDeleteBtn" type="button" onclick="toggleRestaurantDelete('${escapeHtml(item.id)}')">Eliminar</button>` : ""}
            </div>
          </div>
        `;
      }).join("");
    }

    function renderTrashedRestaurants() {
      const box = $("trashedRestaurants");
      const items = state.trashedRestaurants || [];
      $("trashCountBadge").textContent = items.length ? String(items.length) : "";
      $("trashCountBadge").classList.toggle("show", items.length > 0);
      if (!items.length) {
        box.innerHTML = '<div class="emptyState">La papelera esta vacia.</div>';
        return;
      }
      box.innerHTML = items.map((item) => `
        <div class="trashCard">
          <div class="itemTitle">${escapeHtml(item.name || "Restaurante")}</div>
          <div class="itemSub">En papelera. Se eliminara automaticamente en 3 dias desde que se envio aqui.</div>
          <div class="itemSub">Fecha limite: ${new Date((Number(item.trashedAt || 0) + (3 * 24 * 60 * 60 * 1000))).toLocaleString("es-AR")}</div>
          <div class="buttonRow">
            <button class="btn" type="button" onclick="restoreRestaurant('${escapeHtml(item.id)}')">Restaurar</button>
            <button class="btn danger" type="button" onclick="deleteRestaurantPermanent('${escapeHtml(item.id)}')">Eliminar definitivamente</button>
          </div>
        </div>
      `).join("");
    }

    function canInspectRestaurantData() {
      const me = state.me || {};
      return !!(me.restaurantId && (me.role === "admin" || me.role === "mozo"));
    }

    async function loadRestaurantStateForChecklist() {
      state.restaurantState = null;
      if (!canInspectRestaurantData()) return;
      try {
        state.restaurantState = await api("/api/state");
      } catch (error) {
        state.restaurantState = null;
      }
    }

    function checklistItems() {
      const profile = state.profile || {};
      const me = state.me || {};
      const restaurantState = state.restaurantState || {};
      const ownedRestaurants = Array.isArray(profile.ownedRestaurants) ? profile.ownedRestaurants : [];
      const mozoRestaurants = Array.isArray(profile.mozoRestaurants) ? profile.mozoRestaurants : [];
      const products = Array.isArray(restaurantState.products) ? restaurantState.products : [];
      const sales = Array.isArray(restaurantState.sales) ? restaurantState.sales : [];
      const tables = Array.isArray(restaurantState.tables) ? restaurantState.tables : [];
      const settings = restaurantState.settings && typeof restaurantState.settings === "object" ? restaurantState.settings : {};
      const printing = settings.printing && typeof settings.printing === "object" ? settings.printing : {};
      const fiscal = settings.fiscal && typeof settings.fiscal === "object" ? settings.fiscal : {};
      const printers = printing.sectorPrinters && typeof printing.sectorPrinters === "object" ? printing.sectorPrinters : {};
      const printerReady = Object.values(printers).some((value) => !!String(value || "").trim());
      const hasRestaurant = ownedRestaurants.length > 0 || mozoRestaurants.length > 0;
      const hasOpenRestaurant = !!me.restaurantId;
      const hasMenu = products.some((item) => item && item.active !== false);
      const hasSales = sales.length > 0 || !!fiscal.enabled;
      const hasTeam = ownedRestaurants.some((item) => Number(item.pendingMozoCount || 0) > 0) || mozoRestaurants.length > 0;
      const hasTables = tables.length > 0;
      return [
        {
          title: "Crea tu restaurante",
          text: hasRestaurant
            ? "Ya tienes al menos un comercio disponible en tu cuenta."
            : "Crea el primer comercio para empezar a configurar el sistema.",
          done: hasRestaurant,
          actionLabel: hasRestaurant ? "Ver restaurantes" : "Crear restaurante",
          actionType: "panel",
          actionValue: hasRestaurant ? "restaurants" : "createRestaurant"
        },
        {
          title: "Carga tu carta",
          text: hasOpenRestaurant
            ? "Gestiona productos y precios desde un solo lugar."
            : "Entra a un comercio para poder cargar productos y categorias.",
          done: hasMenu,
          actionLabel: hasOpenRestaurant ? "Abrir productos" : "Entrar al comercio",
          actionType: hasOpenRestaurant ? "link" : "panel",
          actionValue: hasOpenRestaurant ? "/admin_productos.html" : "restaurants"
        },
        {
          title: "Empeza a facturar",
          text: hasOpenRestaurant
            ? "Activa el flujo fiscal o registra tu primera venta."
            : "Primero entra a un comercio para configurar facturacion.",
          done: hasSales,
          actionLabel: hasOpenRestaurant ? "Ir a fiscal" : "Entrar al comercio",
          actionType: hasOpenRestaurant ? "link" : "panel",
          actionValue: hasOpenRestaurant ? "/admin_fiscal_test.html" : "restaurants"
        },
        {
          title: "Instala tu impresora",
          text: hasOpenRestaurant
            ? "Define impresoras por sector para comandas y pre-cuentas."
            : "Necesitas abrir un comercio para asociar impresoras.",
          done: printerReady,
          actionLabel: hasOpenRestaurant ? "Configurar" : "Entrar al comercio",
          actionType: hasOpenRestaurant ? "link" : "panel",
          actionValue: hasOpenRestaurant ? "/config.html" : "restaurants"
        },
        {
          title: "Registra tu equipo",
          text: "Invita o administra usuarios que operan el negocio contigo.",
          done: hasTeam,
          actionLabel: "Ver restaurantes",
          actionType: "panel",
          actionValue: "restaurants"
        },
        {
          title: "Disena tu mapa de mesas",
          text: hasOpenRestaurant
            ? "Ordena el salon y deja preparadas las mesas para el servicio."
            : "Abre un comercio para poder trabajar el salon.",
          done: hasTables,
          actionLabel: hasOpenRestaurant ? "Abrir salon" : "Entrar al comercio",
          actionType: hasOpenRestaurant ? "link" : "panel",
          actionValue: hasOpenRestaurant ? "/salon_pc.html" : "restaurants"
        }
      ];
    }

    function renderFirstSteps() {
      const box = $("firstStepsList");
      const items = checklistItems();
      const total = items.length || 1;
      const completed = items.filter((item) => item.done).length;
      const percent = Math.round((completed / total) * 100);
      $("firstStepsProgressFill").style.width = `${percent}%`;
      $("firstStepsProgressPct").textContent = `${percent}%`;
      if (!canInspectRestaurantData()) {
        message("firstStepsMsg", "Para completar automaticamente todos los pasos, entra a uno de tus comercios desde la lista de restaurantes.", "success");
      } else {
        message("firstStepsMsg", "", "");
      }
      box.innerHTML = items.map((item) => `
        <article class="stepCard ${item.done ? "done" : ""}">
          <div class="stepTop">
            <div>
              <div class="stepTitle">${escapeHtml(item.title)}</div>
              <div class="itemSub">${escapeHtml(item.text)}</div>
            </div>
            <span class="stepStatus ${item.done ? "done" : "pending"}">${item.done ? "Listo" : "Pendiente"}</span>
          </div>
          <div class="buttonRow">
            ${item.actionType === "link"
              ? `<a class="btn ${item.done ? "" : "primary"}" href="${escapeHtml(item.actionValue)}">${escapeHtml(item.actionLabel)}</a>`
              : `<button class="btn ${item.done ? "" : "primary"}" type="button" onclick="setMainPanel('${item.actionValue}')">${escapeHtml(item.actionLabel)}</button>`
            }
          </div>
        </article>
      `).join("");
    }

    async function refreshProfile() {
      try {
        const [me, profile] = await Promise.all([
          api("/api/auth/me"),
          api("/api/auth/profile")
        ]);
        if (!me || !me.authenticated) {
          location.replace(loginUrl());
          return;
        }
        state.me = me;
        state.profile = profile;
        state.trashedRestaurants = profile.trashedRestaurants || [];
        await loadRestaurantStateForChecklist();
        renderSummary();
        fillAccountForm();
        renderOwnedRestaurants();
        renderTrashedRestaurants();
        renderFirstSteps();
      } catch (error) {
        if (error.message === "unauthorized") {
          location.replace(loginUrl());
          return;
        }
        message("sideMsg", errorText(error.message), "error");
      }
    }

    async function saveAccount() {
      const username = ($("accountUsername").value || "").trim();
      const payload = {
        name: username,
        username,
        email: ($("accountEmail").value || "").trim(),
      };
      const currentUser = state.profile && state.profile.user ? state.profile.user : {};
      if (!payload.username) return message("accountMsg", "Escribe un usuario.", "error");
      if (!payload.email) return message("accountMsg", "Escribe un mail.", "error");
      const nothingChanged =
        payload.username === (currentUser.username || "") &&
        payload.name === (currentUser.name || "") &&
        payload.email === (currentUser.email || "");
      if (nothingChanged) return message("accountMsg", "No hay cambios para guardar.", "error");
      try {
        await api("/api/auth/setPassword", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        message("accountMsg", "Datos guardados.", "success");
        await refreshProfile();
      } catch (error) {
        message("accountMsg", errorText(error.message), "error");
      }
    }

    async function verifyPasswordSecurity() {
      const profile = state.profile || {};
      const question = String(profile.securityQuestion || "");
      const securityAnswer = ($("passwordRecoveryAnswer").value || "").trim();
      if (!question) return message("passwordMsg", "Primero configura una pregunta de seguridad en Datos de la cuenta.", "error");
      if (!securityAnswer) return message("passwordMsg", "Escribe la respuesta de seguridad.", "error");
      try {
        await api("/api/auth/verifySecurity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ securityAnswer })
        });
        state.passwordVerified = true;
        renderPasswordSteps();
        message("passwordMsg", "Verificacion correcta. Ahora puedes elegir la nueva contrasena.", "success");
      } catch (error) {
        state.passwordVerified = false;
        renderPasswordSteps();
        message("passwordMsg", errorText(error.message), "error");
      }
    }

    async function savePassword() {
      const profile = state.profile || {};
      const user = profile.user || {};
      const question = String(profile.securityQuestion || "");
      const newPassword = $("passwordNew").value || "";
      const confirmPassword = $("passwordConfirm").value || "";
      if (!question) return message("passwordMsg", "Primero configura una pregunta de seguridad en Datos de la cuenta.", "error");
      if (!state.passwordVerified) return message("passwordMsg", "Primero verifica la respuesta de seguridad.", "error");
      if (!newPassword || newPassword.length < 4) return message("passwordMsg", "Usa una contrasena de al menos 4 caracteres.", "error");
      if (newPassword !== confirmPassword) return message("passwordMsg", "Las contrasenas no coinciden.", "error");
      try {
        await api("/api/auth/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: user.username || user.email || "",
            securityAnswer: $("passwordRecoveryAnswer").value || "",
            newPassword
          })
        });
        message("passwordMsg", "Contrasena actualizada.", "success");
        resetPasswordFlow();
      } catch (error) {
        message("passwordMsg", errorText(error.message), "error");
      }
    }

    async function createRestaurant() {
      const name = ($("createRestaurantName").value || "").trim();
      if (!name) return message("createMsg", "Escribe un nombre para el restaurante.", "error");
      try {
        const data = await api("/api/restaurants/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        message("createMsg", "Restaurante creado.", "success");
        $("createRestaurantName").value = "";
        updateCreateRestaurantPreview();
        await refreshProfile();
        setMainPanel("restaurants");
      } catch (error) {
        message("createMsg", errorText(error.message), "error");
      }
    }

    async function trashRestaurant(restaurantId) {
      const confirmName = ($("deleteRestaurantConfirmInput").value || "").trim();
      try {
        const data = await api("/api/restaurants/trash", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restaurantId, confirmName })
        });
        closeDeleteRestaurantModal();
        if (state.profile) state.profile.ownedRestaurants = data.ownedRestaurants || [];
        state.trashedRestaurants = data.trashedRestaurants || [];
        message("sideMsg", "Restaurante enviado a la papelera.", "success");
        renderOwnedRestaurants();
        renderTrashedRestaurants();
        renderSummary();
      } catch (error) {
        message("deleteRestaurantMsg", errorText(error.message), "error");
      }
    }

    async function restoreRestaurant(restaurantId) {
      try {
        const data = await api("/api/restaurants/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restaurantId })
        });
        if (state.profile) state.profile.ownedRestaurants = data.ownedRestaurants || [];
        state.trashedRestaurants = data.trashedRestaurants || [];
        message("trashMsg", "Restaurante restaurado.", "success");
        renderOwnedRestaurants();
        renderTrashedRestaurants();
        renderSummary();
      } catch (error) {
        message("trashMsg", errorText(error.message), "error");
      }
    }

    async function deleteRestaurantPermanent(restaurantId) {
      try {
        const data = await api("/api/restaurants/deletePermanent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restaurantId })
        });
        if (state.profile) state.profile.ownedRestaurants = data.ownedRestaurants || [];
        state.trashedRestaurants = data.trashedRestaurants || [];
        message("trashMsg", "Restaurante eliminado definitivamente.", "success");
        renderOwnedRestaurants();
        renderTrashedRestaurants();
        renderSummary();
      } catch (error) {
        message("trashMsg", errorText(error.message), "error");
      }
    }

    async function decideRequest(requestId, approve) {
      try {
        await api("/api/restaurants/requestDecision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, approve })
        });
        message("sideMsg", approve ? "Solicitud aceptada." : "Solicitud rechazada.", "success");
        await refreshProfile();
      } catch (error) {
        message("sideMsg", errorText(error.message), "error");
      }
    }

    async function enterRestaurant(restaurantId, role) {
      try {
        const data = await api("/api/restaurants/enter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restaurantId, role })
        });
        if (!data.branchId) {
          await openBranchPanel(restaurantId, role, data.restaurantName || "");
          return;
        }
        location.href = defaultPathForRole(data.role);
      } catch (error) {
        message("sideMsg", errorText(error.message), "error");
      }
    }

    async function createBranch() {
      const name = ($("branchName").value || "").trim();
      if (!state.branchRestaurantId) return message("branchCreateMsg", "Primero elige un restaurante.", "error");
      if (!name) return message("branchCreateMsg", "Escribe un nombre para la sucursal.", "error");
      try {
        const data = await api("/api/restaurants/branches/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restaurantId: state.branchRestaurantId, name })
        });
        state.branches = data.branches || [];
        renderBranchList();
        closeCreateBranchModal();
        message("branchMsg", "Sucursal creada. Ahora selecciona esa sucursal para entrar.", "success");
      } catch (error) {
        message("branchCreateMsg", errorText(error.message), "error");
      }
    }

    async function selectBranchAndContinue(branchId) {
      try {
        await api("/api/restaurants/branches/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restaurantId: state.branchRestaurantId, branchId })
        });
        location.href = defaultPathForRole(state.branchRestaurantRole || "admin");
      } catch (error) {
        message("branchMsg", errorText(error.message), "error");
      }
    }

    async function leaveRestaurant() {
      try {
        await api("/api/restaurants/leave", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        message("sideMsg", "Volviste a tu perfil personal.", "success");
        await refreshProfile();
      } catch (error) {
        message("sideMsg", errorText(error.message), "error");
      }
    }

    async function logout() {
      try {
        await api("/api/auth/logout");
      } catch (error) {}
      location.replace(loginUrl());
    }

    $("btnSaveAccount").addEventListener("click", saveAccount);
    $("btnOpenCreateRestaurant").addEventListener("click", () => setMainPanel("createRestaurant"));
    $("btnBackFromCreateRestaurant").addEventListener("click", () => setMainPanel("restaurants"));
    $("btnCreateRestaurant").addEventListener("click", createRestaurant);
    $("btnBackFromBranchPanel").addEventListener("click", () => setMainPanel("restaurants"));
    $("btnOpenCreateBranchModal").addEventListener("click", openCreateBranchModal);
    $("btnCancelCreateBranchModal").addEventListener("click", closeCreateBranchModal);
    $("btnCreateBranch").addEventListener("click", createBranch);
    $("btnCancelDeleteRestaurant").addEventListener("click", closeDeleteRestaurantModal);
    $("btnConfirmDeleteRestaurant").addEventListener("click", () => trashRestaurant(state.deleteRestaurantId));
    $("btnLogout").addEventListener("click", logout);
    $("btnLeaveRestaurant").addEventListener("click", leaveRestaurant);
    $("btnViewAccount").addEventListener("click", () => setMainPanel("account"));
    $("btnViewFirstSteps").addEventListener("click", () => setMainPanel("firstSteps"));
    $("btnViewRestaurants").addEventListener("click", () => setMainPanel("restaurants"));
    $("btnViewTrash").addEventListener("click", () => setMainPanel("trash"));
    $("btnOpenPasswordPanel").addEventListener("click", () => setMainPanel("password"));
    $("btnBackFromPassword").addEventListener("click", () => setMainPanel("account"));
    $("btnVerifyPassword").addEventListener("click", verifyPasswordSecurity);
    $("btnSavePassword").addEventListener("click", savePassword);
    $("createRestaurantName").addEventListener("input", updateCreateRestaurantPreview);
    $("deleteRestaurantModal").addEventListener("click", (event) => {
      if (event.target === $("deleteRestaurantModal")) closeDeleteRestaurantModal();
    });
    $("branchCreateModal").addEventListener("click", (event) => {
      if (event.target === $("branchCreateModal")) closeCreateBranchModal();
    });

    window.enterRestaurant = enterRestaurant;
    window.toggleRestaurantDelete = toggleRestaurantDelete;
    window.trashRestaurant = trashRestaurant;
    window.restoreRestaurant = restoreRestaurant;
    window.deleteRestaurantPermanent = deleteRestaurantPermanent;
    window.selectBranchAndContinue = selectBranchAndContinue;
    window.decideRequest = decideRequest;

    refreshProfile();
  
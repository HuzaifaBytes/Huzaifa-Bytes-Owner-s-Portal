function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function getStatusClass(status) {
  switch (status) {
    case "active": return "status-pill status-active";
    case "pending": return "status-pill status-pending";
    case "deactivated": return "status-pill status-deactivated";
    case "expired": return "status-pill status-expired";
    case "suspended": return "status-pill status-suspended";
    case "revoked": return "status-pill status-revoked";
    default: return "status-pill status-pending";
  }
}

function getBindingStatusClass(status) {
  if (status === "bound") return "status-pill status-active";
  if (status === "blocked") return "status-pill status-deactivated";
  return "status-pill status-pending";
}

function getCustomerLicense(row) {
  if (Array.isArray(row.licenses) && row.licenses.length > 0) {
    return row.licenses[0];
  }
  return row.licenses || null;
}

function getCustomerStatus(row) {
  const license = getCustomerLicense(row);
  const status = (license?.status || row.license_status || "pending").toLowerCase();
  const expiry = license?.expires_at ? new Date(license.expires_at).getTime() : NaN;
  if (status === "pending") return "pending";
  return status === "active" && (!Number.isFinite(expiry) || expiry > Date.now()) ? "active" : "deactivated";
}

async function loadAdminDashboard() {
  const { data, error } = await window.supabaseClient
    .from("profiles")
    .select("id, full_name, email, license_status, licenses(status, expires_at)")
    .eq("is_admin", false)
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    const target = document.getElementById("customerTableBody");
    if (target) {
      target.innerHTML = `<tr><td colspan="5">Unable to load customer records. ${escapeHTML(error.message)}</td></tr>`;
    }
    return [];
  }

  const profiles = data || [];
  const { data: bindings, error: bindingError } = profiles.length
    ? await window.supabaseClient
      .from("local_database_bindings")
      .select("profile_id, local_database_identity, status, bound_at, last_verified_at, last_attempted_ldi, last_attempt_at")
      .in("profile_id", profiles.map((profile) => profile.id))
    : { data: [], error: null };

  if (bindingError) {
    console.error(bindingError);
    const target = document.getElementById("customerTableBody");
    if (target) target.innerHTML = `<tr><td colspan="5">Unable to load installation identity records.</td></tr>`;
    return [];
  }

  const bindingByProfile = new Map((bindings || []).map((binding) => [binding.profile_id, binding]));
  const rows = profiles.map((profile) => ({
    ...profile,
    installationBinding: bindingByProfile.get(profile.id) || null,
  }));
  renderStats(rows);
  renderCustomersTable(rows);
  return rows;
}

function renderStats(rows) {
  const statsGrid = document.getElementById("statsGrid");
  if (!statsGrid) return;

  const totals = {
    total: rows.length,
    pending: rows.filter((row) => getCustomerStatus(row) === "pending").length,
    active: rows.filter((row) => getCustomerStatus(row) === "active").length,
    deactivated: rows.filter((row) => getCustomerStatus(row) === "deactivated").length,
  };

  const cards = [
    { label: "Total registered", value: totals.total },
    { label: "Pending activation", value: totals.pending },
    { label: "Active accounts", value: totals.active },
    { label: "Deactivated accounts", value: totals.deactivated },
  ];

  statsGrid.innerHTML = cards.map((card) => `
    <article class="stat-card">
      <div class="stat-label">${card.label}</div>
      <div class="stat-value">${card.value}</div>
    </article>
  `).join("");
}

function renderCustomersTable(rows) {
  const tableBody = document.getElementById("customerTableBody");
  if (!tableBody) return;

  const search = document.getElementById("searchInput")?.value.trim().toLowerCase() || "";
  const filter = document.getElementById("statusFilter")?.value || "all";

  const visibleRows = rows.filter((row) => {
    const status = getCustomerStatus(row);
    const haystack = [
      row.full_name,
      row.email,
      status,
      row.installationBinding?.local_database_identity,
      row.installationBinding?.status,
    ].join(" ").toLowerCase();

    const matchesSearch = !search || haystack.includes(search);
    const matchesStatus = filter === "all" || status === filter;
    return matchesSearch && matchesStatus;
  });

  if (!visibleRows.length) {
    tableBody.innerHTML = `<tr><td colspan="5">No matching customers found.</td></tr>`;
    return;
  }

  tableBody.innerHTML = visibleRows.map((row) => {
    const status = getCustomerStatus(row);
    return `
      <tr>
        <td>${escapeHTML(row.full_name || "Unnamed customer")}</td>
        <td>${escapeHTML(row.email || "—")}</td>
        <td>
          <span class="${getStatusClass(status)}">${status === "deactivated" ? "Deactivated" : status === "active" ? "Active" : "Pending"}</span>
        </td>
        <td>
          <span class="${getBindingStatusClass(row.installationBinding?.status)}">${escapeHTML(row.installationBinding?.status === "bound" ? "Bound" : row.installationBinding?.status === "blocked" ? "Blocked" : row.installationBinding?.status === "pending" ? "Pending approval" : "Unbound")}</span>
          <div class="ldi-value">${escapeHTML(row.installationBinding?.local_database_identity || "—")}</div>
        </td>
        <td>
          <button class="link-btn" type="button" data-customer-id="${escapeHTML(row.id)}">Manage</button>
        </td>
      </tr>
    `;
  }).join("");

  tableBody.querySelectorAll("[data-customer-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-customer-id");
      if (!id) return;
      window.location.href = `customer-details.html?id=${encodeURIComponent(id)}`;
    });
  });
}

window.applyCustomerFilters = () => {
  const tableBody = document.getElementById("customerTableBody");
  if (tableBody && window.__customerData) {
    renderCustomersTable(window.__customerData);
  }
};

window.__customerData = [];

window.addEventListener("DOMContentLoaded", async () => {
  if (!document.getElementById("statsGrid") && !document.getElementById("customerTableBody")) {
    return;
  }

  const authUser = await window.supabaseClient.auth.getUser();
  if (authUser.error || !authUser.data.user) {
    window.location.href = "index.html";
    return;
  }

  const { data } = await window.supabaseClient
    .from("profiles")
    .select("id, is_admin")
    .eq("id", authUser.data.user.id)
    .single();

  if (!data || !data.is_admin) {
    await window.supabaseClient.auth.signOut();
    window.location.href = "index.html";
    return;
  }

  const userBadge = document.getElementById("userBadge");
  if (userBadge) {
    userBadge.textContent = authUser.data.user.email || "Admin";
  }

  const searchInput = document.getElementById("searchInput");
  const statusFilter = document.getElementById("statusFilter");

  if (searchInput) {
    searchInput.addEventListener("input", window.applyCustomerFilters);
  }

  if (statusFilter) {
    statusFilter.addEventListener("change", window.applyCustomerFilters);
  }

  const rows = await loadAdminDashboard();
  window.__customerData = rows;
});

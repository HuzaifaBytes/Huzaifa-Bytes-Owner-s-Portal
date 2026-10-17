let customerId = null;
let currentAction = "activate";
let currentProfile = null;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function getQueryValue(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "No expiry set";
}

function getStatusClass(status) {
  switch (status) {
    case "active": return "status-pill status-active";
    case "pending": return "status-pill status-pending";
    case "deactivated": return "status-pill status-deactivated";
    default: return "status-pill status-pending";
  }
}

function getEffectiveStatus(row, license) {
  const status = (license?.status || row.license_status || "pending").toLowerCase();
  const expiry = license?.expires_at ? new Date(license.expires_at).getTime() : NaN;
  if (status === "pending") return "pending";
  return status === "active" && (!Number.isFinite(expiry) || expiry > Date.now()) ? "active" : "deactivated";
}

async function loadCustomerProfile() {
  customerId = getQueryValue("id");
  if (!customerId) {
    document.getElementById("detailContainer").textContent = "No customer selected.";
    return null;
  }

  const { data, error } = await window.supabaseClient
    .from("profiles")
    .select("id, full_name, email, license_status, licenses(status, expires_at, activation_days)")
    .eq("id", customerId)
    .single();

  if (error || !data) {
    document.getElementById("detailContainer").textContent = `Unable to load customer data. ${error ? error.message : "Not found."}`;
    return null;
  }

  currentProfile = data;
  renderCustomerDetail(data);
  return data;
}

function renderCustomerDetail(row) {
  const detailContainer = document.getElementById("detailContainer");
  const license = Array.isArray(row.licenses) && row.licenses.length ? row.licenses[0] : row.licenses || {};
  const status = getEffectiveStatus(row, license);

  document.getElementById("customerTitle").textContent = row.full_name || "Customer";

  detailContainer.innerHTML = `
    <div class="details-grid"><div class="detail-card">
      <p><strong>Full Name:</strong> ${escapeHTML(row.full_name || "—")}</p>
      <p><strong>Email:</strong> ${escapeHTML(row.email || "—")}</p>
      <p><strong>Activation Status:</strong> <span class="${getStatusClass(status)}">${status === "deactivated" ? "Deactivated" : status === "active" ? "Active" : "Pending"}</span></p>
      <p><strong>License Duration:</strong> ${license.activation_days ? `${escapeHTML(license.activation_days)} days` : "Not set"}</p>
      <p><strong>Expires:</strong> ${escapeHTML(formatDate(license.expires_at))}</p>
    </div></div>
  `;
  document.querySelectorAll("[data-license-action]").forEach((button) => {
    const action = button.getAttribute("data-license-action");
    button.classList.toggle("hidden", (action === "activate" && status === "active") || (action === "extend" && status !== "active") || (action === "deactivate" && status !== "active"));
  });
}

function getSelectedDays() {
  const preset = document.getElementById("daysPreset")?.value;
  const value = preset === "custom" ? document.getElementById("customDays")?.value : preset;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 0;
}

function openLicenseModal(action) {
  currentAction = action;
  const modal = document.getElementById("licenseModal");
  const title = document.getElementById("modalTitle");
  const durationGroup = document.getElementById("licenseDaysGroup");
  const customGroup = document.getElementById("customDayGroup");
  const preset = document.getElementById("daysPreset");

  if (!modal || !title) return;

  const actionMap = {
    activate: "Activate account and set duration",
    extend: "Extend license duration",
    deactivate: "Deactivate account",
  };

  title.textContent = actionMap[action] || "Update license";
  durationGroup?.classList.toggle("hidden", action === "deactivate");
  customGroup?.classList.toggle("hidden", preset?.value !== "custom");
  modal.classList.add("open");
  const preview = document.getElementById("expiryPreview");
  if (preview) {
    const days = getSelectedDays();
    preview.textContent = action === "deactivate"
      ? `Confirm deactivation for ${currentProfile?.full_name || "this customer"}.`
      : days ? `This will grant ${days} days of access.` : "Choose a valid duration from 1 to 3650 days.";
  }
}

function closeLicenseModal() {
  const modal = document.getElementById("licenseModal");
  if (modal) {
    modal.classList.remove("open");
  }
}

async function handleLicenseAction(event) {
  event.preventDefault();

  if (!customerId) return;

  const action = currentAction;
  const customerName = currentProfile?.full_name || "this customer";
  const days = action === "deactivate" ? null : getSelectedDays();
  if (action !== "deactivate" && !days) {
    document.getElementById("expiryPreview").textContent = "Choose a valid duration from 1 to 3650 days.";
    return;
  }
  const confirmation = days
    ? `Confirm ${action} for ${customerName} for ${days} days?`
    : `Confirm ${action} for ${customerName}?`;
  if (!window.confirm(confirmation)) return;

  const payload = {
    p_profile_id: customerId,
    p_action: action,
    p_days: days,
    p_reason: action === "deactivate" ? "owner deactivated account" : `owner ${action} for ${days} days`,
  };

  const { data, error } = await window.supabaseClient.rpc("apply_license_action", payload);

  if (error) {
    document.getElementById("expiryPreview").textContent = error.message || "The license update could not be completed.";
    return;
  }

  closeLicenseModal();
  await loadCustomerProfile();
  if (window.loadAdminDashboard) {
    await window.loadAdminDashboard();
  }
}

function bindLicenseActions() {
  document.querySelectorAll("[data-license-action]").forEach((button) => {
    button.addEventListener("click", () => openLicenseModal(button.getAttribute("data-license-action")));
  });

  const cancel = document.getElementById("cancelModal");
  if (cancel) cancel.addEventListener("click", closeLicenseModal);

  const daysPreset = document.getElementById("daysPreset");
  const customGroup = document.getElementById("customDayGroup");
  const customDays = document.getElementById("customDays");
  const updateDurationPreview = () => {
    const days = getSelectedDays();
    const preview = document.getElementById("expiryPreview");
    if (customGroup && daysPreset) customGroup.classList.toggle("hidden", daysPreset.value !== "custom");
    if (preview && currentAction !== "deactivate") {
      preview.textContent = days ? `This will grant ${days} days of access.` : "Choose a valid duration from 1 to 3650 days.";
    }
  };
  daysPreset?.addEventListener("change", updateDurationPreview);
  customDays?.addEventListener("input", updateDurationPreview);

  const form = document.getElementById("licenseForm");
  if (form) form.addEventListener("submit", handleLicenseAction);
}

window.addEventListener("DOMContentLoaded", async () => {
  const pageName = window.location.pathname.split("/").pop();
  if (pageName !== "customer-details.html") return;

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

  bindLicenseActions();
  await loadCustomerProfile();
});

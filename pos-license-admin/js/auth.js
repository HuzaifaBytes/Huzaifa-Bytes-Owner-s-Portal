const supabaseClient = window.supabaseClient;

function setAuthMessage(message, type = "") {
  const target = document.getElementById("authMessage");
  if (!target) return;
  target.textContent = message;
  target.className = `status-message ${type}`.trim();
}

async function ensureAdminAccess(user) {
  if (!user) return false;

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, is_admin")
    .eq("id", user.id)
    .single();

  if (error || !data || !data.is_admin) {
    await supabaseClient.auth.signOut();
    return false;
  }

  return true;
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById("email")?.value.trim();
  const password = document.getElementById("password")?.value;

  if (!email || !password) {
    setAuthMessage("Enter your admin email and password.", "error");
    return;
  }

  setAuthMessage("Signing in…");

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      setAuthMessage(error.message || "Login failed.", "error");
      return;
    }

    const hasAccess = await ensureAdminAccess(data.user);

    if (!hasAccess) {
      setAuthMessage("This account is not authorized for the admin portal.", "error");
      return;
    }

    window.location.href = "customers.html";
  } catch (error) {
    setAuthMessage(error.message || "Unexpected sign-in error.", "error");
  }
}

async function handleLogout() {
  try {
    await supabaseClient.auth.signOut();
    window.location.href = "index.html";
  } catch (error) {
    console.error(error);
    window.location.href = "index.html";
  }
}

async function redirectIfSignedIn() {
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (!session) return;

  const isAdmin = await ensureAdminAccess(session.user);
  if (isAdmin) {
    window.location.href = "customers.html";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", handleLogin);
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", handleLogout);
  }

  const pageName = window.location.pathname.split("/").pop() || "index.html";
  if (pageName === "index.html" || pageName === "login.html") {
    await redirectIfSignedIn();
  }
});

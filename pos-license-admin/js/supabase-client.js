(function () {
  const config = {
    url: "https://zsgbodkgugniaqzhufhw.supabase.co",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzZ2JvZGtndWduaWFxemh1Zmh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2NDg0MzUsImV4cCI6MjEwNzIyNDQzNX0.yoOKwNI4Ytfv1eZkXzZ3dDSlnXIBaUGZIwJT5i6wZuY",
  };

  const url = config.url || "https://your-project.supabase.co";
  const key = config.key || "your-anon-key";

  if (url.includes("your-project") || key.includes("your-")) {
    console.warn("Supabase URL and key are still placeholders. Update the config before deploying the admin portal.");
  }

  window.supabaseClient = window.supabaseClient || window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
})();

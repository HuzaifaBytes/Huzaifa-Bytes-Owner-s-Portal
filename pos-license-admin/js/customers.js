document.addEventListener("DOMContentLoaded", () => {
  const tableBody = document.getElementById("customerTableBody");
  if (!tableBody) return;

  const searchInput = document.getElementById("searchInput");
  const statusFilter = document.getElementById("statusFilter");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (window.applyCustomerFilters) {
        window.applyCustomerFilters();
      }
    });
  }

  if (statusFilter) {
    statusFilter.addEventListener("change", () => {
      if (window.applyCustomerFilters) {
        window.applyCustomerFilters();
      }
    });
  }
});

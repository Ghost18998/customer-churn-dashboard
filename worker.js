$("kCustomers").classList.remove("loading");
$("kChurn").classList.remove("loading");
$("kMonthly").classList.remove("loading");
// worker.js
// Offloads heavy churn computations from the UI thread

self.onmessage = (e) => {
  const { rows, filters, whatIf } = e.data;

  const applyFilters = (rows) => {
    const { contract, internet, tMin, tMax } = filters;
    return rows.filter(r => {
      if (contract !== "All" && r.contract !== contract) return false;
      if (internet !== "All" && r.internet !== internet) return false;
      if (r.tenure < tMin || r.tenure > tMax) return false;
      return true;
    });
  };

  const filtered = applyFilters(rows);

  const churnRate = (r) =>
    r.length ? (r.filter(x => x.churn).length / r.length) * 100 : 0;

  const avgMonthly = (r) =>
    r.length ? r.reduce((s, x) => s + x.monthly, 0) / r.length : 0;

  const response = {
    count: filtered.length,
    churn: churnRate(filtered),
    avgMonthly: avgMonthly(filtered)
  };

  self.postMessage(response);
};

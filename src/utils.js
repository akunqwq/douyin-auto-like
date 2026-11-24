  const formatDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

  const formatRemaining = (ms) => {
    const total = Math.ceil(ms / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };

  const on = (target, type, handler, options = {}) => {
    target.addEventListener(type, handler, options);
  };

  const observe = (target, options, callback) => {
    new MutationObserver(callback).observe(target, options);
  };

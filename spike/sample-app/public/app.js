(function () {
  const params = new URLSearchParams(location.search);
  const variant = params.get("variant") || "pr";
  const bugs = (params.get("bug") || "").split(",").filter(Boolean);
  document.body.dataset.variant = variant;
  document.body.dataset.bug = bugs.join(" ");
  const hasBug = (b) => bugs.includes(b);

  const products = [
    { id: 1, name: "Orchid Mantis", price: 62 },
    { id: 2, name: "Gold Tortoise", price: 18 },
    { id: 3, name: "Blue Beetle", price: 25 },
  ];
  const state = { tab: "home", product: null, cart: [] };
  const main = document.getElementById("main");
  const title = document.getElementById("screen-title");
  const badge = document.querySelector('[data-testid="cart-badge"]');
  const toast = document.getElementById("toast");

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove("hidden");
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function render() {
    document.querySelectorAll("nav.tabs button").forEach((b) => {
      if (b.dataset.tab === state.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    badge.textContent = String(state.cart.length);
    if (state.tab === "home") {
      title.textContent = "Home";
      main.innerHTML = `<p>Witaj w Acme Shop.</p><p data-testid="promo-banner">Promocja dnia: -10% na chrząszcze</p>`;
    } else if (state.tab === "products") {
      title.textContent = "Products";
      main.innerHTML = products
        .map((p) => `<div class="card" role="button" tabindex="0" data-product="${p.id}" data-testid="product-card-${p.id}" aria-label="${p.name}, ${p.price} zł"><strong>${p.name}</strong><div class="price">${p.price} zł</div></div>`)
        .join("");
      main.querySelectorAll("[data-product]").forEach((el) =>
        el.addEventListener("click", () => { state.product = products.find((p) => p.id === Number(el.dataset.product)); state.tab = "product"; render(); }),
      );
    } else if (state.tab === "product" && state.product) {
      const p = state.product;
      title.textContent = "Product";
      main.innerHTML = `<h2 data-testid="product-name">${p.name}</h2><p class="price" data-testid="product-price">${p.price} zł</p><p>Opis produktu ${p.name}.</p>
        <button class="cta" data-testid="add-to-cart">Dodaj do koszyka</button>`;
      main.querySelector('[data-testid="add-to-cart"]').addEventListener("click", () => {
        const added = hasBug("toast-name") ? products[1] : p; // bug: wrong product
        state.cart.push(hasBug("badge") ? null : added);
        if (hasBug("badge")) state.cart.pop();
        if (variant !== "base") showToast(`Dodano: ${added.name}`);
        render();
      });
    } else if (state.tab === "cart") {
      title.textContent = "Cart";
      main.innerHTML = state.cart.length
        ? state.cart.map((p, i) => `<div class="card"><strong>${p.name}</strong> <span class="price">${p.price} zł</span> <button class="danger" data-remove="${i}">Usuń</button></div>`).join("")
        : `<p data-testid="cart-empty">Koszyk jest pusty.</p>`;
      main.querySelectorAll("[data-remove]").forEach((el) => el.addEventListener("click", () => { state.cart.splice(Number(el.dataset.remove), 1); render(); }));
    } else {
      title.textContent = "Profile";
      main.innerHTML = `<p>Użytkownik testowy</p><button class="danger" data-testid="delete-account">Usuń konto</button>`;
    }
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); }));
  render();
})();

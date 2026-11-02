(function () {
  "use strict";
  /* ---------- Safe storage: localStorage with in-memory fallback ---------- */
  var memStore = {};
  var storage = {
    get: function (k) {
      try {
        var v = window.localStorage.getItem(k);
        return v === null ? (k in memStore ? memStore[k] : null) : v;
      } catch (e) {
        return k in memStore ? memStore[k] : null;
      }
    },
    set: function (k, v) {
      memStore[k] = v;
      try {
        window.localStorage.setItem(k, v);
      } catch (e) {}
    },
    remove: function (k) {
      delete memStore[k];
      try {
        window.localStorage.removeItem(k);
      } catch (e) {}
    },
  };

  function escapeHtml(s) {
    return String(s === null || s === undefined ? "" : s).replace(
      /[&<>"']/g,
      function (c) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c];
      },
    );
  }

  /* ---------- API access ---------- */
  var baseMeta = document.querySelector('meta[name="jos-api-base"]');
  var API_BASE = ((baseMeta && baseMeta.getAttribute("content")) || "")
    .trim()
    .replace(/\/+$/, "");
  var GET_TIMEOUT = 15000;
  var ORDER_TIMEOUT = 120000; // a 5 MB screenshot can take a while on mobile data
  var POLL_MS = 20000;

  /* Resolves to { status, ok, body } (body is null if not JSON); rejects only
     when no HTTP response arrived at all, including on timeout. */
  function request(path, opts, timeoutMs) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () {
        ctrl.abort();
      }, timeoutMs);
    }
    return fetch(API_BASE + path, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try {
            body = JSON.parse(text);
          } catch (e) {}
          return { status: res.status, ok: res.ok, body: body };
        });
      })
      .then(
        function (r) {
          clearTimeout(timer);
          return r;
        },
        function (err) {
          clearTimeout(timer);
          throw err;
        },
      );
  }
  function apiGet(path) {
    return request(
      path,
      { headers: { Accept: "application/json" }, cache: "no-store" },
      GET_TIMEOUT,
    ).then(function (r) {
      if (!r.ok || !r.body) throw new Error("Bad response from " + path);
      return r.body;
    });
  }
  function imageUrl(u) {
    u = String(u || "");
    if (/^https?:\/\//i.test(u)) return u;
    if (!u || u.indexOf("//") === 0 || /^[a-z][a-z0-9+.-]*:/i.test(u)) return "";
    return API_BASE + (u.charAt(0) === "/" ? u : "/" + u);
  }

  /* ---------- Product art (inline SVG, blush + gold) ---------- */
  function jarArt(color, label) {
    return (
      '<svg width="150" height="168" viewBox="0 0 48 54" fill="none" aria-hidden="true">' +
      '<ellipse cx="24" cy="8" rx="13" ry="4.5" stroke="#A8872A" stroke-width="1.7"/>' +
      '<path d="M11 10 L13.5 16 H34.5 L37 10" stroke="#A8872A" stroke-width="1.7"/>' +
      '<path d="M13.5 16 C11 24 11.5 38 14 46 C15 49.5 18 51 24 51 C30 51 33 49.5 34 46 C36.5 38 37 24 34.5 16" stroke="#A8872A" stroke-width="1.7"/>' +
      '<path d="M15 34 C18 30 21 32 24 35 C27 32 30 30 33 34 C32 41 29 45 24 45 C19 45 16 41 15 34Z" fill="' +
      color +
      '" opacity=".55"/>' +
      '<circle cx="24" cy="27" r="3.2" fill="#A8872A"/><path d="M22.7 29.3 L21.5 36.5 H26.5 L25.3 29.3Z" fill="#A8872A"/>' +
      '<path d="M5 20 l1.1 2.4 2.5 1-2.5 1L5 26.8 3.9 24.4 1.4 23.4l2.5-1Z" fill="#B9975B"/>' +
      '</svg><div style="font-size:.78rem;font-weight:800;letter-spacing:.12em;color:#A8872A;text-transform:uppercase;margin-top:2px">' +
      label +
      "</div>"
    );
  }
  function candleArt(color, label) {
    return (
      '<svg width="130" height="168" viewBox="0 0 48 54" fill="none" aria-hidden="true">' +
      '<path d="M24 4 C27 8 27 11 24 14 C21 11 21 8 24 4Z" fill="#E9B44C"/>' +
      '<path d="M24 9 C25.6 11 25.6 12.6 24 14.2 C22.4 12.6 22.4 11 24 9Z" fill="#F7D774"/>' +
      '<rect x="23.2" y="14" width="1.6" height="4" fill="#A8872A"/>' +
      '<path d="M13 20 H35 L33.5 46 C33.3 49 31 50.5 24 50.5 C17 50.5 14.7 49 14.5 46 Z" fill="' +
      (color || "#F4B8C1") +
      '" opacity=".5" stroke="#A8872A" stroke-width="1.7"/>' +
      '<path d="M13.6 26 H34.4" stroke="#A8872A" stroke-width="1.2" opacity=".6"/>' +
      '<circle cx="24" cy="36" r="3" fill="#A8872A"/><path d="M22.8 38.2 L21.8 44.5 H26.2 L25.2 38.2Z" fill="#A8872A"/>' +
      '<path d="M40 22 l.9 2 2.1.9-2.1.9-.9 2-.9-2-2.1-.9 2.1-.9Z" fill="#B9975B"/>' +
      '</svg><div style="font-size:.78rem;font-weight:800;letter-spacing:.12em;color:#A8872A;text-transform:uppercase;margin-top:2px">' +
      (label || "Hidden Message") +
      "</div>"
    );
  }
  function boxArt(color, label) {
    return (
      '<svg width="160" height="168" viewBox="0 0 54 54" fill="none" aria-hidden="true">' +
      '<rect x="8" y="22" width="38" height="24" rx="3" fill="' +
      (color || "#F4B8C1") +
      '" opacity=".55" stroke="#A8872A" stroke-width="1.7"/>' +
      '<rect x="5" y="14" width="44" height="9" rx="3" stroke="#A8872A" stroke-width="1.7" fill="none"/>' +
      '<path d="M27 14 V46" stroke="#A8872A" stroke-width="2.4"/>' +
      '<path d="M27 14 C22 6 13 8 15 13 C16.4 16.4 23 15 27 14Z" stroke="#A8872A" stroke-width="1.6" fill="none"/>' +
      '<path d="M27 14 C32 6 41 8 39 13 C37.6 16.4 31 15 27 14Z" stroke="#A8872A" stroke-width="1.6" fill="none"/>' +
      '<circle cx="27" cy="33" r="2.8" fill="#A8872A"/><path d="M25.9 35.1 L25 40.5 H29 L28.1 35.1Z" fill="#A8872A"/>' +
      '</svg><div style="font-size:.78rem;font-weight:800;letter-spacing:.12em;color:#A8872A;text-transform:uppercase;margin-top:2px">' +
      (label || "Secret Gift Box") +
      "</div>"
    );
  }
  function ringArt(color, label) {
    return (
      '<svg width="140" height="168" viewBox="0 0 48 54" fill="none" aria-hidden="true">' +
      '<ellipse cx="24" cy="10" rx="12" ry="4" stroke="#A8872A" stroke-width="1.7"/>' +
      '<path d="M12 12 L14 17 H34 L36 12" stroke="#A8872A" stroke-width="1.7" fill="none"/>' +
      '<path d="M14 17 C12.4 25 12.8 37 14.8 44 C15.7 47.4 18.4 49 24 49 C29.6 49 32.3 47.4 33.2 44 C35.2 37 35.6 25 34 17" stroke="#A8872A" stroke-width="1.7" fill="none"/>' +
      '<circle cx="24" cy="33" r="6.5" stroke="#B9975B" stroke-width="2.2" fill="none"/>' +
      '<path d="M24 22 L27 26.5 L24 29.5 L21 26.5Z" fill="' +
      (color || "#F4B8C1") +
      '" stroke="#A8872A" stroke-width="1.2"/>' +
      '<path d="M6 22 l1 2.2 2.3.9-2.3.9-1 2.2-.9-2.2-2.3-.9 2.3-.9Z" fill="#B9975B"/>' +
      '</svg><div style="font-size:.78rem;font-weight:800;letter-spacing:.12em;color:#A8872A;text-transform:uppercase;margin-top:2px">' +
      (label || "Keepsake") +
      "</div>"
    );
  }
  function makeArt(art, category) {
    var cat = escapeHtml(category);
    if (!art || typeof art !== "object") return jarArt("#F4B8C1", cat);
    var color =
      typeof art.color === "string" && /^#[0-9a-fA-F]{6}$/.test(art.color)
        ? art.color
        : null;
    var label = art.label ? escapeHtml(art.label) : "";
    if (art.kind === "candle") return candleArt(color, label);
    if (art.kind === "box") return boxArt(color, label);
    if (art.kind === "ring") return ringArt(color, label);
    return jarArt(color || "#F4B8C1", label || cat);
  }
  function thumbArt(p) {
    return p.art
      .replace('width="150"', 'width="40"')
      .replace('width="130"', 'width="36"')
      .replace('width="160"', 'width="42"')
      .replace('width="140"', 'width="38"');
  }
  function cartArt(p) {
    return p.art
      .replace('width="150"', 'width="52"')
      .replace('width="130"', 'width="46"')
      .replace('width="160"', 'width="56"')
      .replace('width="140"', 'width="50"');
  }
  function imgTag(p, idx) {
    return (
      '<img src="' +
      escapeHtml(p.images[idx]) +
      '" alt="' +
      escapeHtml(p.name) +
      '" loading="lazy" data-art-for="' +
      escapeHtml(p.id) +
      '">'
    );
  }

  /* ---------- Catalogue (always from the API; there is no local fallback) ---------- */
  var catalogue = [];
  var categories = ["All"];
  var catalogueState = "loading"; // "loading" | "failed" | "ready"
  var catalogueJson = null;
  var catalogueSeq = 0;
  var catalogueBusy = false;

  function parseSpecs(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(function (line) {
        return line.trim();
      })
      .filter(Boolean)
      .map(function (line) {
        var at = line.indexOf(": ");
        return at > 0
          ? [line.slice(0, at).trim(), line.slice(at + 2).trim()]
          : [line];
      });
  }
  function mapProduct(a) {
    var cat = String(a.category || "");
    return {
      id: String(a.id),
      rawId: a.id,
      name: String(a.name || ""),
      cat: cat,
      price: Number(a.price) || 0,
      stock: Math.max(0, Math.floor(Number(a.stock) || 0)),
      short: String(a.shortDescription || ""),
      desc: String(a.description || ""),
      specs: parseSpecs(a.specifications),
      images: (Array.isArray(a.images) ? a.images : [])
        .map(imageUrl)
        .filter(Boolean),
      art: makeArt(a.art, cat),
    };
  }
  function buildCategories() {
    var list = ["All"];
    catalogue.forEach(function (p) {
      if (p.cat && list.indexOf(p.cat) === -1) list.push(p.cat);
    });
    return list;
  }

  /* ---------- Settings (always from the API) ---------- */
  var settings = null;
  var settingsJson = null;
  var settingsBusy = false;
  var THANK_MSG =
    "Thank you for your order! Your order has been successfully received. Our team will contact you shortly.";
  var ONLINE_UNAVAILABLE_MSG =
    "Online payment isn't available right now — please choose Cash on Delivery";
  var NETWORK_MSG =
    "We couldn't reach the store. Your order hasn't been confirmed — please check your connection and try again.";
  function blockMsg() {
    return (
      "Sorry! We currently provide delivery services only within " +
      (settings ? settings.deliveryCity : "our delivery city") +
      ". Delivery to your selected city is not available."
    );
  }

  /* ---------- State ---------- */
  var MAX_QTY = 100; // the API rejects a line above this
  var cart = [];
  try {
    var saved = storage.get("jos_public_cart");
    if (saved) {
      var parsed = JSON.parse(saved);
      if (Array.isArray(parsed))
        parsed.forEach(function (i) {
          if (
            !i ||
            typeof i.id !== "string" ||
            typeof i.qty !== "number" ||
            Math.floor(i.qty) !== i.qty ||
            i.qty < 1
          )
            return;
          var dup = null;
          cart.forEach(function (x) {
            if (x.id === i.id) dup = x;
          });
          if (dup) dup.qty += i.qty;
          else cart.push(i);
        });
    }
  } catch (e) {
    cart = [];
  }
  var activeCat = "All",
    searchTerm = "",
    detailId = null,
    detailQty = 1,
    detailImg = 0,
    detailSig = null,
    shotData = null,
    shotName = "",
    shotMime = "",
    shotSize = 0,
    shotReading = false,
    shotToken = 0,
    placing = false;

  function $(id) {
    return document.getElementById(id);
  }
  function money(n) {
    return "PKR " + Number(n).toLocaleString("en-PK");
  }
  function byId(id) {
    for (var i = 0; i < catalogue.length; i++)
      if (catalogue[i].id === id) return catalogue[i];
    return null;
  }
  function maxQty(p) {
    return Math.min(p.stock, MAX_QTY);
  }
  function limitMsg(p) {
    return p.stock > MAX_QTY
      ? "You can order up to " + MAX_QTY + " of an item at a time."
      : "Only " + p.stock + " available in stock.";
  }
  function saveCart() {
    try {
      storage.set("jos_public_cart", JSON.stringify(cart));
    } catch (e) {}
    updateCartCount();
  }
  function cartCount() {
    return cart.reduce(function (s, i) {
      return s + i.qty;
    }, 0);
  }
  function cartSubtotal() {
    return cart.reduce(function (s, i) {
      var p = byId(i.id);
      return s + (p ? p.price * i.qty : 0);
    }, 0);
  }
  function subtotalText() {
    if (cart.length && catalogueState !== "ready") return "—";
    return money(cartSubtotal());
  }
  function totalText() {
    if (!cart.length) return money(0);
    if (catalogueState !== "ready" || !settings) return "—";
    return money(cartSubtotal() + settings.deliveryFee);
  }
  function updateCartCount() {
    $("cartCount").textContent = cartCount();
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("show");
    }, ms || 2600);
  }

  function showView(name) {
    var views = ["shop", "detail", "cart", "checkout", "confirm"];
    views.forEach(function (v) {
      $("view-" + v).classList.toggle("active", v === name);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function viewIs(name) {
    return $("view-" + name).classList.contains("active");
  }

  /* Live re-renders replace buttons; put keyboard focus back on the same one. */
  var FOCUS_ATTRS = [
    "data-cat",
    "data-view",
    "data-add",
    "data-dec",
    "data-inc",
    "data-rem",
  ];
  function keepFocus(box, render) {
    var a = document.activeElement,
      attr = null,
      val = null;
    if (a && box.contains(a))
      FOCUS_ATTRS.forEach(function (n) {
        if (a.hasAttribute(n)) {
          attr = n;
          val = a.getAttribute(n);
        }
      });
    render();
    if (attr)
      box.querySelectorAll("[" + attr + "]").forEach(function (el) {
        if (el.getAttribute(attr) === val) el.focus({ preventScroll: true });
      });
  }

  /* ---------- Shop rendering ---------- */
  function renderChips() {
    keepFocus($("chipRow"), function () {
      $("chipRow").innerHTML = categories
        .map(function (c) {
          return (
            '<button class="chip' +
            (c === activeCat ? " active" : "") +
            '" data-cat="' +
            escapeHtml(c) +
            '">' +
            escapeHtml(c) +
            "</button>"
          );
        })
        .join("");
      var chips = $("chipRow").querySelectorAll("[data-cat]");
      for (var i = 0; i < chips.length; i++)
        chips[i].addEventListener("click", function () {
          activeCat = this.getAttribute("data-cat");
          renderChips();
          renderGrid();
        });
    });
  }
  function renderGrid() {
    var grid = $("productGrid");
    if (catalogueState === "loading") {
      grid.innerHTML = '<div class="empty">Loading our collection…</div>';
      return;
    }
    if (catalogueState === "failed") {
      grid.innerHTML =
        '<div class="empty"><b>We couldn\'t load our collection.</b><br>Please check your connection and try again.<br>' +
        '<button class="btn btnGold btnSm" data-retry="1" style="margin-top:14px">Retry</button></div>';
      return;
    }
    if (!catalogue.length) {
      grid.innerHTML =
        '<div class="empty"><b>Nothing to show just yet.</b><br>Please check back soon.</div>';
      return;
    }
    var list = catalogue.filter(function (p) {
      var okCat = activeCat === "All" || p.cat === activeCat;
      var q = searchTerm.trim().toLowerCase();
      var okQ =
        !q ||
        (p.name + " " + p.short + " " + p.cat).toLowerCase().indexOf(q) !== -1;
      return okCat && okQ;
    });
    if (!list.length) {
      grid.innerHTML =
        '<div class="empty"><b>No matches found.</b><br>Try a different search word or category.</div>';
      return;
    }
    keepFocus(grid, function () {
      grid.innerHTML = list
        .map(function (p) {
          var stock =
            p.stock <= 0
              ? '<span class="stockNote low">Out of stock</span>'
              : p.stock <= 5
                ? '<span class="stockNote low">Only ' +
                  p.stock +
                  " left in stock</span>"
                : '<span class="stockNote">In stock</span>';
          return (
            '<article class="card">' +
            '<div class="cardArt">' +
            (p.images.length ? imgTag(p, 0) : p.art) +
            "</div>" +
            '<div class="cardBody"><span class="catTag">' +
            escapeHtml(p.cat) +
            "</span>" +
            "<h3>" +
            escapeHtml(p.name) +
            "</h3><p>" +
            escapeHtml(p.short) +
            "</p>" +
            '<div class="priceRow"><span class="price">' +
            money(p.price) +
            "</span></div>" +
            stock +
            '<div class="cardBtns"><button class="btn btnOutline btnSm" data-view="' +
            escapeHtml(p.id) +
            '">View Details</button>' +
            '<button class="btn btnGold btnSm" data-add="' +
            escapeHtml(p.id) +
            '"' +
            (p.stock <= 0 ? " disabled" : "") +
            ">Add to Cart</button></div>" +
            "</div></article>"
          );
        })
        .join("");
      grid.querySelectorAll("[data-view]").forEach(function (b) {
        b.addEventListener("click", function () {
          openDetail(this.getAttribute("data-view"));
        });
      });
      grid.querySelectorAll("[data-add]").forEach(function (b) {
        b.addEventListener("click", function () {
          addToCart(this.getAttribute("data-add"), 1);
        });
      });
    });
  }

  /* ---------- Detail ---------- */
  function openDetail(id) {
    if (!byId(id)) return;
    detailId = id;
    detailQty = 1;
    detailImg = 0;
    detailSig = null;
    renderDetail();
    showView("detail");
  }
  /* Safe to call on every catalogue change: leaves the chosen thumbnail and
     quantity alone, except to pull the quantity back within stock. */
  function renderDetail() {
    var p = byId(detailId);
    if (!p) {
      $("dStock").textContent = "This product is no longer available.";
      $("dAdd").disabled = true;
      $("dBuy").disabled = true;
      return;
    }
    detailQty = Math.max(1, Math.min(detailQty, maxQty(p)));
    $("qtyVal").textContent = detailQty;
    $("dCat").textContent = p.cat;
    $("dName").textContent = p.name;
    $("dPrice").textContent = money(p.price);
    $("dStock").textContent =
      p.stock > 0 ? "In stock — " + p.stock + " available" : "Out of stock";
    $("dDesc").textContent = p.desc;
    var sig = JSON.stringify([p.images, p.art, p.name]);
    if (sig !== detailSig) {
      detailSig = sig;
      if (detailImg >= p.images.length) detailImg = 0;
      renderDetailArt(p);
    }
    $("dSpecs").style.display = p.specs.length ? "" : "none";
    $("dSpecs").innerHTML = p.specs
      .map(function (s) {
        return s.length === 2
          ? "<tr><td>" +
              escapeHtml(s[0]) +
              "</td><td>" +
              escapeHtml(s[1]) +
              "</td></tr>"
          : '<tr><td colspan="2">' + escapeHtml(s[0]) + "</td></tr>";
      })
      .join("");
    $("dAdd").disabled = p.stock <= 0;
    $("dBuy").disabled = p.stock <= 0;
  }
  function renderDetailArt(p) {
    var hasImages = p.images.length > 0;
    $("detailArt").innerHTML = hasImages ? imgTag(p, detailImg) : p.art;
    var count = hasImages ? p.images.length : 3;
    var slots = [];
    for (var n = 0; n < count; n++) slots.push(n);
    $("detailThumbs").innerHTML = slots
      .map(function (i) {
        return (
          '<button class="thumb' +
          (i === detailImg ? " active" : "") +
          '" data-img="' +
          i +
          '" aria-label="Product image ' +
          (i + 1) +
          '">' +
          (hasImages ? imgTag(p, i) : thumbArt(p)) +
          "</button>"
        );
      })
      .join("");
    $("detailThumbs")
      .querySelectorAll(".thumb")
      .forEach(function (t) {
        t.addEventListener("click", function () {
          $("detailThumbs")
            .querySelectorAll(".thumb")
            .forEach(function (x) {
              x.classList.remove("active");
            });
          this.classList.add("active");
          detailImg = Number(this.getAttribute("data-img")) || 0;
          if (hasImages) $("detailArt").innerHTML = imgTag(p, detailImg);
        });
      });
  }

  /* ---------- Cart ---------- */
  function addToCart(id, qty) {
    var p = byId(id);
    if (!p) return;
    var found = null;
    cart.forEach(function (i) {
      if (i.id === id) found = i;
    });
    var current = found ? found.qty : 0;
    if (current + qty > maxQty(p)) {
      toast(limitMsg(p));
      return;
    }
    if (found) found.qty += qty;
    else cart.push({ id: id, qty: qty, name: p.name });
    saveCart();
    toast(p.name + " added to cart.");
  }
  function setQty(id, qty) {
    var p = byId(id);
    if (p && qty > maxQty(p)) toast(limitMsg(p));
    cart = cart.map(function (i) {
      if (i.id === id) i.qty = Math.max(1, Math.min(qty, p ? maxQty(p) : qty));
      return i;
    });
    saveCart();
    renderCart();
    renderCheckoutSummary();
  }
  function removeItem(id) {
    cart = cart.filter(function (i) {
      return i.id !== id;
    });
    saveCart();
    renderCart();
    renderCheckoutSummary();
  }
  /* Brings the cart in line with a catalogue that was just fetched successfully.
     `prev` is the catalogue before this fetch. Returns true if anything changed. */
  function reconcileCart(prev) {
    if (orderInDoubt()) return false;
    var notes = [],
      changed = false;
    function prevOf(id) {
      for (var n = 0; n < prev.length; n++)
        if (prev[n].id === id) return prev[n];
      return null;
    }
    var next = [];
    cart.forEach(function (i) {
      var p = byId(i.id),
        old = prevOf(i.id);
      if (!p) {
        notes.push(
          ((old && old.name) || i.name || "An item") +
            " is no longer available and was removed from your cart.",
        );
        changed = true;
        return;
      }
      if (p.stock <= 0) {
        notes.push(p.name + " is out of stock and was removed from your cart.");
        changed = true;
        return;
      }
      if (i.qty > maxQty(p)) {
        i.qty = maxQty(p);
        notes.push(
          "Only " + i.qty + " of " + p.name + " available — your cart was updated.",
        );
        changed = true;
      }
      if (old && old.price !== p.price) {
        notes.push(p.name + " is now " + money(p.price) + ".");
        changed = true;
      }
      if (i.name !== p.name) {
        i.name = p.name;
        changed = true;
      }
      next.push(i);
    });
    cart = next;
    if (changed) saveCart();
    if (notes.length) toast(notes.join(" "), 6000);
    return changed;
  }

  function renderCart() {
    var panel = $("cartItemsPanel");
    if (!cart.length) {
      panel.innerHTML =
        '<div style="text-align:center;padding:26px 8px;color:var(--muted)"><b style="color:var(--ink)">Your cart is empty.</b><br>Add a little secret or two from the shop.</div>';
    } else if (catalogueState !== "ready") {
      panel.innerHTML =
        '<div style="text-align:center;padding:26px 8px;color:var(--muted)">' +
        (catalogueState === "failed"
          ? '<b style="color:var(--ink)">We couldn\'t load your cart right now.</b><br>Your items are still saved. Please check your connection and try again.'
          : "Loading your cart…") +
        "</div>";
    } else {
      keepFocus(panel, function () {
        panel.innerHTML = cart
          .map(function (i) {
            var p = byId(i.id);
            if (!p) return "";
            return (
              '<div class="cartItem"><div class="cartThumb">' +
              (p.images.length ? imgTag(p, 0) : cartArt(p)) +
              "</div>" +
              '<div class="cartMeta"><h4>' +
              escapeHtml(p.name) +
              '</h4><span style="color:var(--gold);font-weight:800">' +
              money(p.price) +
              "</span>" +
              '<div style="display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap"><span class="qtyCtrl">' +
              '<button data-dec="' +
              escapeHtml(p.id) +
              '" aria-label="Decrease">−</button><span>' +
              i.qty +
              '</span><button data-inc="' +
              escapeHtml(p.id) +
              '" aria-label="Increase">+</button></span>' +
              '<button class="removeBtn" data-rem="' +
              escapeHtml(p.id) +
              '">Remove</button></div></div>' +
              '<div style="font-weight:800;white-space:nowrap">' +
              money(p.price * i.qty) +
              "</div></div>"
            );
          })
          .join("");
        panel.querySelectorAll("[data-inc]").forEach(function (b) {
          b.addEventListener("click", function () {
            var id = b.getAttribute("data-inc");
            var it = null;
            cart.forEach(function (x) {
              if (x.id === id) it = x;
            });
            if (it) setQty(it.id, it.qty + 1);
          });
        });
        panel.querySelectorAll("[data-dec]").forEach(function (b) {
          b.addEventListener("click", function () {
            var id = b.getAttribute("data-dec");
            var it = null;
            cart.forEach(function (x) {
              if (x.id === id) it = x;
            });
            if (it) setQty(it.id, it.qty - 1);
          });
        });
        panel.querySelectorAll("[data-rem]").forEach(function (b) {
          b.addEventListener("click", function () {
            removeItem(this.getAttribute("data-rem"));
          });
        });
      });
    }
    $("sumSub").textContent = subtotalText();
    $("sumTotal").textContent = totalText();
    $("goCheckout").disabled = !cart.length || catalogueState !== "ready";
  }

  /* ---------- Checkout ---------- */
  function renderCheckoutSummary() {
    var box = $("checkoutItems");
    if (!box) return;
    box.innerHTML = cart
      .map(function (i) {
        var p = byId(i.id);
        if (!p) return "";
        return (
          '<div class="sumRow"><span>' +
          escapeHtml(p.name) +
          " × " +
          i.qty +
          "</span><span>" +
          money(p.price * i.qty) +
          "</span></div>"
        );
      })
      .join("");
    $("coSub").textContent = subtotalText();
    $("coTotal").textContent = totalText();
    renderBankBox();
  }
  function selectedPay() {
    var r = document.querySelector('input[name="pay"]:checked');
    return r ? r.value : "cod";
  }
  function refreshPayUI() {
    var pay = selectedPay();
    $("optCod").classList.toggle("sel", pay === "cod");
    $("optBank").classList.toggle("sel", pay === "bank");
    $("bankBox").classList.toggle("show", pay === "bank");
    if (!placing)
      $("placeOrderBtn").textContent =
        pay === "bank" ? "Done — Confirm Order" : "Place Order";
    renderBankBox();
  }

  /* ---------- Bank details ---------- */
  var bank = null,
    bankFailed = false,
    bankSeq = 0,
    bankHtml = null;
  function bankStatus() {
    if (settings && !settings.onlinePaymentAvailable) return "unavailable";
    if (bank) return bank.configured ? "ready" : "unavailable";
    return bankFailed ? "error" : "loading";
  }
  function bankRow(label, value) {
    return (
      '<div class="sumRow"><span>' +
      label +
      '</span><span class="bankVal">' +
      value +
      "</span></div>"
    );
  }
  function renderBankBox() {
    var status = bankStatus(),
      html;
    if (status === "unavailable") {
      html =
        '<div class="alert err show" style="margin:8px 0 0">' +
        escapeHtml(ONLINE_UNAVAILABLE_MSG) +
        "</div>";
    } else if (status === "error") {
      html =
        '<p style="margin:8px 0">We couldn\'t load our bank details. Please check your connection and try again, or choose Cash on Delivery.</p>' +
        '<button type="button" class="btn btnOutline btnSm" data-bank-retry="1">Retry</button>';
    } else if (status === "loading") {
      html = '<p style="margin:8px 0">Loading our bank details…</p>';
    } else {
      html =
        '<p style="margin:8px 0">Transfer the exact total to the account below, then upload a screenshot of the successful payment here.</p>' +
        bankRow("Bank", escapeHtml(bank.bankName)) +
        bankRow("Account title", escapeHtml(bank.bankAccountTitle)) +
        bankRow("Account number", escapeHtml(bank.bankAccountNumber)) +
        (bank.bankIban ? bankRow("IBAN", escapeHtml(bank.bankIban)) : "") +
        bankRow("Amount to transfer", escapeHtml(totalText())) +
        (bank.paymentInstructions
          ? '<p style="margin:8px 0;white-space:pre-line">' +
            escapeHtml(bank.paymentInstructions) +
            "</p>"
          : "");
    }
    if (html !== bankHtml) {
      bankHtml = html;
      $("bankDetails").innerHTML = html;
    }
    $("bankHowTitle").style.display = status === "unavailable" ? "none" : "";
    $("shotField").style.display = status === "ready" ? "" : "none";
  }
  function loadBankDetails() {
    var seq = ++bankSeq;
    if (!bank) bankFailed = false;
    renderBankBox();
    return apiGet("/api/checkout/bank-details").then(
      function (d) {
        if (seq !== bankSeq) return;
        bank = d;
        bankFailed = false;
        renderBankBox();
      },
      function () {
        if (seq !== bankSeq) return;
        bankFailed = true;
        renderBankBox();
      },
    );
  }

  /* ---------- Duplicate prevention ---------- */
  var ORDER_KEY = "jos_public_order_key";
  function newOrderKey() {
    if (window.crypto && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.prototype.map
      .call(bytes, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
  }
  /* Short hash, so customer details aren't written to browser storage. */
  function hashText(text) {
    var h1 = 0xdeadbeef,
      h2 = 0x41c6ce57;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
  }
  function orderFingerprint(customer, pay) {
    var lines = cart
      .map(function (i) {
        return i.id + "\u0000" + i.qty;
      })
      .sort();
    return hashText(
      JSON.stringify([
        lines,
        customer,
        pay,
        pay === "bank" ? [shotName, shotSize] : null,
      ]),
    );
  }
  function readOrderRecord() {
    try {
      var r = JSON.parse(storage.get(ORDER_KEY));
      return r && typeof r.key === "string" && typeof r.fp === "string" ? r : null;
    } catch (e) {
      return null;
    }
  }
  /* Same fingerprint = same attempt, so a retry after a lost response gets the
     original order back from the server instead of creating a second one. */
  function orderKeyFor(fp) {
    var r = readOrderRecord();
    if (r && r.fp === fp) return r.key;
    var key = newOrderKey();
    storage.set(ORDER_KEY, JSON.stringify({ fp: fp, key: key, inDoubt: false }));
    return key;
  }
  function setOrderInDoubt(flag) {
    var r = readOrderRecord();
    if (!r) return;
    r.inDoubt = flag;
    storage.set(ORDER_KEY, JSON.stringify(r));
  }
  /* True when an order attempt got no definite answer, so it may exist on the
     server. Its own stock deduction would then clamp the cart, which would change
     the fingerprint, and the retry would become a second order. The cart therefore
     stays as submitted until the retry gets a definite answer. */
  function orderInDoubt() {
    var r = readOrderRecord();
    return !!(r && r.inDoubt);
  }

  /* ---------- Placing an order ---------- */
  function showAlert(el, msg) {
    el.textContent = msg;
    el.classList.add("show");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function digitsOk(v) {
    return /^\d{10,15}$/.test(v.replace(/[+\-() ]/g, ""));
  }
  function setPlacing(flag) {
    placing = flag;
    $("placeOrderBtn").disabled = flag;
    if (flag) $("placeOrderBtn").textContent = "Placing your order…";
    else refreshPayUI();
  }
  function placeOrder(ev) {
    ev.preventDefault();
    if (placing) return;
    var name = $("fName").value.trim(),
      mobile = $("fMobile").value.trim(),
      whats = $("fWhats").value.trim(),
      email = $("fEmail").value.trim(),
      addr = $("fAddress").value.trim(),
      city = $("fCity").value,
      pay = selectedPay();
    var cityAlert = $("cityAlert"),
      formAlert = $("formAlert");
    cityAlert.classList.remove("show");
    formAlert.classList.remove("show");
    if (!cart.length) {
      showAlert(formAlert, "Your cart is empty. Please add a product first.");
      return;
    }
    if (!settings) {
      showAlert(
        formAlert,
        "We couldn't load our delivery details. Please check your connection and try again.",
      );
      loadSettings();
      return;
    }
    if (!name || !mobile || !whats || !email || !addr || !city) {
      showAlert(
        formAlert,
        "Please fill in all fields marked * — name, mobile, WhatsApp, email, complete address and city.",
      );
      return;
    }
    if (name.length < 2 || name.length > 100) {
      showAlert(formAlert, "Please enter your full name (2–100 characters).");
      return;
    }
    if (!digitsOk(mobile)) {
      showAlert(formAlert, "Please enter a valid mobile number (10–15 digits).");
      return;
    }
    if (!digitsOk(whats)) {
      showAlert(formAlert, "Please enter a valid WhatsApp number (10–15 digits).");
      return;
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAlert(formAlert, "Please enter a valid email address.");
      return;
    }
    if (addr.length < 8 || addr.length > 500) {
      showAlert(
        formAlert,
        "Please enter your complete delivery address (8–500 characters).",
      );
      return;
    }
    if (city !== settings.deliveryCity) {
      showAlert(cityAlert, blockMsg());
      return;
    }
    if (pay === "bank") {
      var status = bankStatus();
      if (status === "unavailable") {
        showAlert(formAlert, ONLINE_UNAVAILABLE_MSG);
        return;
      }
      if (status !== "ready") {
        showAlert(
          formAlert,
          "We don't have our bank details on screen yet. Please wait a moment or try again, or choose Cash on Delivery.",
        );
        loadBankDetails();
        return;
      }
      if (shotReading) {
        showAlert(
          formAlert,
          "Your screenshot is still loading. Please try again in a moment.",
        );
        return;
      }
      if (!shotData) {
        showAlert(
          formAlert,
          "Please upload your payment screenshot before confirming a bank transfer order.",
        );
        return;
      }
    }
    var customer = {
      name: name,
      mobile: mobile,
      whatsapp: whats,
      email: email,
      address: addr,
      city: city,
    };
    var payload = {
      customer: customer,
      items: cart.map(function (i) {
        var p = byId(i.id);
        return { productId: p ? p.rawId : i.id, quantity: i.qty };
      }),
      paymentMethod: pay === "bank" ? "online" : "cod",
      screenshot:
        pay === "bank"
          ? { name: shotName, mime: shotMime, data: shotData }
          : null,
      idempotencyKey: orderKeyFor(orderFingerprint(customer, pay)),
    };
    setPlacing(true);
    request(
      "/api/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      },
      ORDER_TIMEOUT,
    ).then(handleOrderResponse, function () {
      setOrderInDoubt(true);
      setPlacing(false);
      showAlert(formAlert, NETWORK_MSG);
    });
  }
  function handleOrderResponse(r) {
    var b = r.body || {},
      formAlert = $("formAlert");
    setPlacing(false);
    if (
      (r.status === 201 || (r.status === 200 && b.duplicate === true)) &&
      b.order &&
      b.order.id
    ) {
      orderPlaced(b.order);
      return;
    }
    if (r.status >= 500 || !b.code) {
      setOrderInDoubt(true);
      showAlert(formAlert, b.error ? String(b.error) : NETWORK_MSG);
      return;
    }
    setOrderInDoubt(false);
    if (b.code === "CITY_NOT_SERVED") {
      showAlert($("cityAlert"), String(b.error || blockMsg()));
      loadSettings();
      return;
    }
    showAlert(
      formAlert,
      String(
        b.error ||
          "Your order hasn't been confirmed. Please check your details and try again.",
      ),
    );
    if (b.code === "OUT_OF_STOCK" || b.code === "PRODUCT_UNAVAILABLE") {
      loadCatalogue(true).then(function () {
        renderCart();
        renderCheckoutSummary();
      });
    }
    if (b.code === "ONLINE_PAYMENT_UNAVAILABLE") {
      loadSettings();
      loadBankDetails();
    }
  }
  function orderPlaced(order) {
    storage.remove(ORDER_KEY);
    showConfirmation(order);
    cart = [];
    saveCart();
    renderCart();
    renderCheckoutSummary();
    $("checkoutForm").reset();
    clearShot();
    refreshPayUI();
    showView("confirm");
    loadCatalogue(true);
  }
  /* Everything shown here comes from the server's response, not from the browser. */
  function showConfirmation(order) {
    var isBank = order.paymentMethod === "online";
    var who = order.customer || {};
    $("confOrderId").textContent = order.id;
    var note = $("confPayNote");
    note.style.display = "block";
    if (isBank) {
      note.innerHTML =
        "<b>Payment Verification Pending</b> — we've received your screenshot. Our team will verify your transfer and confirm your order.";
    } else {
      note.innerHTML =
        "<b>Cash on Delivery</b> — Please keep <b>" +
        money(order.total) +
        "</b> ready in cash when your order arrives.";
    }
    var itemsHtml = (order.items || [])
      .map(function (i) {
        return (
          '<div class="sumRow"><span>' +
          escapeHtml(i.name) +
          " × " +
          escapeHtml(i.quantity) +
          "</span><span>" +
          money(i.lineTotal) +
          "</span></div>"
        );
      })
      .join("");
    $("confDetails").innerHTML =
      '<div class="sumRow"><span>Customer</span><span>' +
      escapeHtml(who.name) +
      "</span></div>" +
      '<div class="sumRow"><span>City</span><span>' +
      escapeHtml(who.city) +
      "</span></div>" +
      '<div class="sumRow"><span>Payment method</span><span>' +
      (isBank ? "Online Bank Transfer" : "Cash on Delivery") +
      "</span></div>" +
      '<div class="sumRow"><span>Order status</span><span>' +
      escapeHtml(order.orderStatus) +
      "</span></div>" +
      '<div class="sumRow"><span>Payment status</span><span>' +
      escapeHtml(order.paymentStatus) +
      "</span></div>" +
      '<div style="border-top:1px solid var(--line);margin-top:8px;padding-top:6px">' +
      itemsHtml +
      "</div>" +
      '<div class="sumRow"><span>Subtotal</span><span>' +
      money(order.subtotal) +
      "</span></div>" +
      '<div class="sumRow"><span>Delivery</span><span>' +
      money(order.deliveryFee) +
      "</span></div>" +
      '<div class="sumRow total"><span>Total</span><span>' +
      money(order.total) +
      "</span></div>" +
      '<p style="color:var(--muted)">' +
      THANK_MSG +
      "</p>";
  }

  /* ---------- Screenshot ---------- */
  var MAX_SHOT_BYTES = 5 * 1024 * 1024;
  function clearShot() {
    shotToken++;
    shotData = null;
    shotName = "";
    shotMime = "";
    shotSize = 0;
    shotReading = false;
    $("shotPreview").classList.remove("show");
    $("shotImg").removeAttribute("src");
    setShotNote("", false);
  }
  function setShotNote(msg, isError) {
    $("shotName").textContent = msg;
    $("shotName").style.color = isError ? "var(--danger)" : "";
  }
  function inferMime(f) {
    var okTypes = ["image/png", "image/jpeg", "application/pdf"];
    if (f.type === "image/jpg") return "image/jpeg";
    if (okTypes.indexOf(f.type) !== -1) return f.type;
    if (/\.png$/i.test(f.name)) return "image/png";
    if (/\.jpe?g$/i.test(f.name)) return "image/jpeg";
    if (/\.pdf$/i.test(f.name)) return "application/pdf";
    return "";
  }
  function onShotChange() {
    var input = this;
    var f = input.files && input.files[0];
    clearShot();
    if (!f) return;
    var mime = inferMime(f);
    if (!mime) {
      input.value = "";
      setShotNote("Please choose a JPG, PNG or PDF file.", true);
      return;
    }
    if (f.size > MAX_SHOT_BYTES) {
      input.value = "";
      setShotNote(
        "That file is too large. Please choose one that is 5 MB or smaller.",
        true,
      );
      return;
    }
    if (!f.size) {
      input.value = "";
      setShotNote("That file is empty. Please choose another one.", true);
      return;
    }
    var token = shotToken;
    shotReading = true;
    var reader = new FileReader();
    reader.onload = function (e) {
      if (token !== shotToken) return;
      var url = String(e.target.result);
      shotReading = false;
      shotData = url.slice(url.indexOf(",") + 1);
      shotName = f.name;
      shotMime = mime;
      shotSize = f.size;
      if (mime.indexOf("image/") === 0) {
        $("shotImg").src = url;
        $("shotPreview").classList.add("show");
      }
      setShotNote("Attached: " + f.name, false);
    };
    reader.onerror = function () {
      if (token !== shotToken) return;
      shotReading = false;
      input.value = "";
      setShotNote(
        "We couldn't read that file. Please choose it again or try another one.",
        true,
      );
    };
    reader.readAsDataURL(f);
  }

  /* ---------- Loading and keeping live ---------- */
  function applyCatalogue(list) {
    var prev = catalogue;
    var json = JSON.stringify(list);
    var changed = json !== catalogueJson || catalogueState !== "ready";
    if (changed) {
      catalogueJson = json;
      catalogue = list.map(mapProduct);
      catalogueState = "ready";
      var cats = buildCategories();
      if (cats.indexOf(activeCat) === -1) activeCat = "All";
      categories = cats;
      renderChips();
      renderGrid();
    }
    var cartChanged = reconcileCart(prev);
    if (changed || cartChanged) {
      renderCart();
      renderCheckoutSummary();
      if (viewIs("detail")) renderDetail();
    }
  }
  /* force: a new request supersedes any in flight (after an order or on Retry). */
  function loadCatalogue(force) {
    if (!force && (catalogueBusy || placing)) return Promise.resolve();
    var seq = ++catalogueSeq;
    catalogueBusy = true;
    return apiGet("/api/products").then(
      function (body) {
        if (seq !== catalogueSeq) return;
        catalogueBusy = false;
        if (placing) return;
        if (!Array.isArray(body.products)) return catalogueFailed();
        applyCatalogue(body.products);
      },
      function () {
        if (seq !== catalogueSeq) return;
        catalogueBusy = false;
        catalogueFailed();
      },
    );
  }
  /* Keeps the last good data and never touches the cart. */
  function catalogueFailed() {
    if (catalogueJson !== null) return;
    catalogueState = "failed";
    renderGrid();
    renderCart();
    renderCheckoutSummary();
  }
  function bindText(name, text) {
    document
      .querySelectorAll('[data-bind="' + name + '"]')
      .forEach(function (el) {
        el.textContent = text;
      });
  }
  function fillCities(list) {
    var sel = $("fCity"),
      current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    list.forEach(function (c) {
      var o = document.createElement("option");
      o.textContent = c;
      o.value = c;
      sel.appendChild(o);
    });
    sel.value = list.indexOf(current) !== -1 ? current : "";
  }
  function checkCityField() {
    var a = $("cityAlert"),
      v = $("fCity").value;
    if (v && settings && v !== settings.deliveryCity) {
      a.textContent = blockMsg();
      a.classList.add("show");
    } else a.classList.remove("show");
  }
  function applySettings(s) {
    var json = JSON.stringify(s);
    if (json === settingsJson) return;
    var oldCities = settings ? JSON.stringify(settings.cities) : null;
    settingsJson = json;
    var cities = (Array.isArray(s.cities) ? s.cities : []).map(String);
    if (cities.indexOf(String(s.deliveryCity)) === -1)
      cities.unshift(String(s.deliveryCity));
    settings = {
      deliveryCity: String(s.deliveryCity),
      deliveryFee: Number(s.deliveryFee) || 0,
      cities: cities,
      onlinePaymentAvailable: s.onlinePaymentAvailable === true,
    };
    bindText("fee", money(settings.deliveryFee));
    bindText("city", settings.deliveryCity);
    bindText(
      "payFooter",
      settings.onlinePaymentAvailable
        ? "Cash on Delivery & Bank Transfer"
        : "Cash on Delivery",
    );
    bindText(
      "payHint",
      settings.onlinePaymentAvailable
        ? "Pay cash on delivery or by bank transfer."
        : "Pay cash on delivery.",
    );
    if (JSON.stringify(cities) !== oldCities) fillCities(cities);
    checkCityField();
    renderCart();
    renderCheckoutSummary();
  }
  function settingsUnavailable() {
    if (settings) return;
    /* Don't quote a delivery charge we couldn't confirm next to a real subtotal. */
    document
      .querySelectorAll('.sumRow [data-bind="fee"]')
      .forEach(function (el) {
        el.textContent = "—";
      });
    renderCart();
    renderCheckoutSummary();
  }
  function loadSettings() {
    if (settingsBusy) return Promise.resolve();
    settingsBusy = true;
    return apiGet("/api/settings/public").then(
      function (s) {
        settingsBusy = false;
        if (typeof s.deliveryFee !== "number" || !s.deliveryCity)
          return settingsUnavailable();
        applySettings(s);
      },
      function () {
        settingsBusy = false;
        settingsUnavailable();
      },
    );
  }
  function refreshLive() {
    loadCatalogue(false);
    loadSettings();
    if (viewIs("checkout") && selectedPay() === "bank") loadBankDetails();
  }
  function retryLoad() {
    catalogueState = "loading";
    renderGrid();
    renderCart();
    loadCatalogue(true);
    loadSettings();
  }

  /* ---------- Wiring ---------- */
  function init() {
    renderChips();
    renderGrid();
    renderCart();
    updateCartCount();
    $("productGrid").addEventListener("click", function (e) {
      if (e.target && e.target.hasAttribute("data-retry")) retryLoad();
    });
    $("bankDetails").addEventListener("click", function (e) {
      if (e.target && e.target.hasAttribute("data-bank-retry")) {
        bankFailed = false;
        loadBankDetails();
      }
    });
    /* A product photo that fails to load falls back to its placeholder art. */
    document.addEventListener(
      "error",
      function (e) {
        var img = e.target;
        if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-art-for"))
          return;
        var p = byId(img.getAttribute("data-art-for")),
          host = img.parentNode;
        if (!p || !host) return;
        if (host.classList.contains("thumb")) host.innerHTML = thumbArt(p);
        else if (host.classList.contains("cartThumb"))
          host.innerHTML = cartArt(p);
        else host.innerHTML = p.art;
      },
      true,
    );
    $("searchInput").addEventListener("input", function () {
      searchTerm = this.value;
      renderGrid();
    });
    $("brandHome").addEventListener("click", function () {
      showView("shop");
    });
    $("navShop").addEventListener("click", function () {
      showView("shop");
      document.getElementById("shopAnchor").scrollIntoView({ behavior: "smooth" });
    });
    $("navCart").addEventListener("click", function () {
      renderCart();
      showView("cart");
    });
    $("heroShopBtn").addEventListener("click", function () {
      document.getElementById("shopAnchor").scrollIntoView({ behavior: "smooth" });
    });
    $("heroGiftBtn").addEventListener("click", function () {
      activeCat = "Gift Boxes";
      renderChips();
      renderGrid();
      document.getElementById("shopAnchor").scrollIntoView({ behavior: "smooth" });
    });
    document.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () {
        var v = this.getAttribute("data-go");
        if (v === "cart") renderCart();
        showView(v);
      });
    });
    $("qtyMinus").addEventListener("click", function () {
      detailQty = Math.max(1, detailQty - 1);
      $("qtyVal").textContent = detailQty;
    });
    $("qtyPlus").addEventListener("click", function () {
      var p = byId(detailId);
      var max = p ? maxQty(p) : 1;
      detailQty = Math.max(1, Math.min(max, detailQty + 1));
      $("qtyVal").textContent = detailQty;
    });
    $("dAdd").addEventListener("click", function () {
      if (detailId) addToCart(detailId, detailQty);
    });
    $("dBuy").addEventListener("click", function () {
      if (detailId) {
        addToCart(detailId, detailQty);
        renderCart();
        showView("cart");
      }
    });
    $("goCheckout").addEventListener("click", function () {
      renderCheckoutSummary();
      refreshPayUI();
      if (selectedPay() === "bank") loadBankDetails();
      showView("checkout");
    });
    document.querySelectorAll('input[name="pay"]').forEach(function (r) {
      r.addEventListener("change", function () {
        refreshPayUI();
        if (selectedPay() === "bank") {
          loadSettings();
          loadBankDetails();
        }
      });
    });
    $("fCity").addEventListener("change", checkCityField);
    $("fShot").addEventListener("change", onShotChange);
    $("checkoutForm").addEventListener("submit", placeOrder);

    loadCatalogue(true);
    loadSettings();
    setInterval(function () {
      if (!document.hidden) refreshLive();
    }, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refreshLive();
    });
    window.addEventListener("focus", refreshLive);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();

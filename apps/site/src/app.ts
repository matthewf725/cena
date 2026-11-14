type SignupRole = "customer" | "restaurant";
type WaitlistRole = "customer" | "restaurant_owner";

(() => {

interface CenaConfig {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

interface PreviewSignup {
  email: string;
  role: SignupRole;
  createdAt: string;
}

const requiredElement = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required page element is missing: ${selector}`);
  return element;
};

const form = requiredElement<HTMLFormElement>("#signup-form");
const emailInput = requiredElement<HTMLInputElement>("#email");
const status = requiredElement<HTMLParagraphElement>("#form-status");
const previewNote = requiredElement<HTMLParagraphElement>("#preview-note");
const submit = requiredElement<HTMLButtonElement>('#signup-form button[type="submit"]');
const config = (window as Window & { CENA_CONFIG?: CenaConfig }).CENA_CONFIG ?? {};
const supabaseUrl = (config.SUPABASE_URL ?? config.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const supabaseKey = config.SUPABASE_ANON_KEY ?? config.VITE_SUPABASE_ANON_KEY ?? "";
const live = Boolean(supabaseUrl && supabaseKey);

requiredElement<HTMLElement>("#year").textContent = String(new Date().getFullYear());
previewNote.hidden = live;

const setStatus = (message: string, kind: "" | "error" | "success" = ""): void => {
  status.textContent = message;
  status.dataset.state = kind;
};

const selectedRole = (): SignupRole => {
  const checked = form.querySelector<HTMLInputElement>('input[name="role"]:checked');
  return checked?.value === "restaurant" ? "restaurant" : "customer";
};

document.querySelectorAll<HTMLAnchorElement>('[data-role-link="restaurant"]').forEach((link) => {
  link.addEventListener("click", () => {
    const restaurantRole = form.querySelector<HTMLInputElement>('input[name="role"][value="restaurant"]');
    if (restaurantRole) restaurantRole.checked = true;
  });
});

emailInput.addEventListener("input", () => {
  emailInput.removeAttribute("aria-invalid");
  if (status.dataset.state === "error") setStatus("");
});

form.addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  const role = selectedRole();

  if (!emailInput.checkValidity()) {
    emailInput.setAttribute("aria-invalid", "true");
    setStatus(email ? "That email doesn't look quite right. Give it another try." : "Add your email address to join the list.", "error");
    emailInput.focus();
    return;
  }

  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  submit.textContent = "Joining…";
  setStatus("");

  try {
    if (live) {
      const waitlistRole: WaitlistRole = role === "restaurant" ? "restaurant_owner" : "customer";
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/join_waitlist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseKey,
          ...(supabaseKey.startsWith("eyJ") ? { Authorization: `Bearer ${supabaseKey}` } : {}),
        },
        body: JSON.stringify({ p_email: email, p_role: waitlistRole }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Request failed (${response.status})`);
      }

      setStatus("You’re on the list. We’ll be in touch when Cena is ready.", "success");
    } else {
      const storageKey = "cena_waitlist_preview";
      const entries = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as PreviewSignup[];
      const normalizedEmail = email.toLowerCase();
      const existingIndex = entries.findIndex((entry) => entry.email.toLowerCase() === normalizedEmail);
      const entry: PreviewSignup = { email, role, createdAt: new Date().toISOString() };

      if (existingIndex >= 0) entries[existingIndex] = entry;
      else entries.push(entry);

      localStorage.setItem(storageKey, JSON.stringify(entries));
      setStatus("Preview signup saved in this browser.", "success");
    }

    form.reset();
    emailInput.removeAttribute("aria-invalid");
  } catch (error: unknown) {
    console.error("Cena waitlist signup failed:", error);
    setStatus(
      live
        ? "We couldn’t add you just now. Please try again in a moment."
        : "This browser could not save your signup. Check local storage and try again.",
      "error",
    );
  } finally {
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
    submit.innerHTML = 'Join the list <span aria-hidden="true">↗</span>';
  }
});
})();

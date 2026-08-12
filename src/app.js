(function () {
  const TOKEN_KEY = "study-platform-token-v2";
  const THEME_KEY = "study-platform-theme";
  const MAX_FILE_SIZE = 20 * 1024 * 1024;
  const MAX_FILES = 10;

  const statusLabels = {
    assigned: "Назначено",
    new: "Новое",
    in_progress: "В работе",
    submitted: "Отправлено",
    reviewing: "Проверяется",
    checked: "Проверено",
    revision: "Нужно исправить",
    overdue: "Просрочено"
  };

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  async function enablePushNotifications({ askPermission = false } = {}) {
    if (!token) return;
    if (isAndroidApp()) {
      syncAndroidAuthToken();
      pushState = { status: "android-app", message: "Уведомления приложения подключаются через Android." };
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      pushState = { status: "unsupported", message: "Это устройство не поддерживает push-уведомления." };
      return;
    }

    pushState = { status: "checking", message: "Проверяем уведомления..." };
    const config = await api("/api/push/config").catch(() => null);
    if (!config?.enabled || !config.publicKey) {
      pushState = { status: "server-off", message: "Уведомления на сервере еще не настроены." };
      return;
    }

    if (Notification.permission === "denied") {
      pushState = { status: "blocked", message: "Уведомления заблокированы в настройках браузера." };
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      if (Notification.permission !== "granted") {
        if (!askPermission) {
          pushState = { status: "permission-needed", message: "Нужно один раз разрешить уведомления." };
          return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          pushState = { status: permission === "denied" ? "blocked" : "permission-needed", message: "Без разрешения система не будет показывать уведомления." };
          return;
        }
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey)
      });
    }

    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
    pushState = { status: "enabled", message: "Уведомления включены." };
  }

  let token = localStorage.getItem(TOKEN_KEY);
  let theme = localStorage.getItem(THEME_KEY) || "light";
  let user = null;
  let students = [];
  let groups = [];
  let assignments = [];
  let lessons = [];
  let notifications = [];
  let profile = null;
  let pushState = { status: "idle", message: "" };
  let view = "dashboard";
  let modal = null;
  let previewAttachment = null;
  let annotationTool = "pen";
  let annotationColor = "#dc2626";
  let annotationSize = 8;
  let annotationPenMenuOpen = false;
  let expandedLessonId = null;
  let selectedLessonDate = "";
  let selectedCalendarDate = "";
  let calendarDetailsHidden = false;
  let calendarMonthOffset = 0;
  let calendarViewMode = "month";
  let calendarFiltersVisible = true;
  let calendarStudentFilter = "all";
  let calendarFormatFilter = "all";
  let calendarStatusFilter = "all";
  let calendarSearch = "";
  let selectedAssignmentStudentId = "";
  let selectedAssignmentGroupId = "";
  let sidebarCollapsed = false;
  let mobileSidebarOpen = false;
  let themeMenuOpen = false;
  let busy = false;
  let error = "";

  function applyTheme() {
    document.body.dataset.theme = theme;
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || "Ошибка запроса.");
      err.status = response.status;
      throw err;
    }
    return data;
  }

  function syncAndroidAuthToken() {
    if (!window.UrokroomAndroid || typeof window.UrokroomAndroid.syncAuthToken !== "function") return;
    try {
      window.UrokroomAndroid.syncAuthToken(token || "");
    } catch (err) {
      // Android bridge can be unavailable in a regular browser.
    }
  }

  function isAndroidApp() {
    return Boolean(window.UrokroomAndroid && typeof window.UrokroomAndroid.syncAuthToken === "function");
  }

  async function bootstrap() {
    if (!token) {
      render();
      return;
    }
    try {
      const data = await api("/api/auth/me");
      user = data.user;
      syncAndroidAuthToken();
      await loadData();
      enablePushNotifications().then(() => render()).catch(() => {});
    } catch (err) {
      if (err.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        token = null;
        user = null;
      } else {
        error = "Нет подключения к серверу. Проверь интернет и обнови страницу.";
      }
    }
    render();
  }

  async function loadData() {
    if (!user) return;
    const requests = [
      api("/api/groups"),
      api("/api/assignments"),
      api("/api/lessons"),
      api("/api/notifications")
    ];
    if (user.role === "teacher") requests.unshift(api("/api/students"));
    else requests.push(api("/api/profile"));
    const results = await Promise.all(requests);
    if (user.role === "teacher") {
      profile = null;
      students = results[0].students;
      groups = results[1].groups;
      assignments = results[2].assignments;
      lessons = results[3].lessons;
      notifications = results[4].notifications;
    } else {
      groups = results[0].groups;
      assignments = results[1].assignments;
      lessons = results[2].lessons;
      notifications = results[3].notifications;
      profile = results[4];
      if (profile?.user) user = profile.user;
      students = deriveStudents();
    }
    normalizeViewForRole();
    enablePushNotifications().then(() => render()).catch(() => {});
  }

  function normalizeViewForRole() {
    if (user?.role === "parent" && !["calendar", "assignments", "progress"].includes(view)) {
      view = "calendar";
    }
  }

  function deriveStudents() {
    const map = new Map();
    if (profile?.student) {
      map.set(profile.student.id, profile.student);
    }
    lessons.forEach((lesson) => {
      if (lesson.studentId && !map.has(lesson.studentId)) {
        map.set(lesson.studentId, { id: lesson.studentId, user: user, color: "#3B82F6", paidLessons: 0, lessonPrice: 0, averageScore: averageScore(lesson.studentId), grade: "", notes: "" });
      }
    });
    assignments.forEach((assignment) => {
      assignment.recipients.forEach((recipient) => {
        if (!map.has(recipient.studentId)) {
          map.set(recipient.studentId, { id: recipient.studentId, user: user, color: "#3B82F6", paidLessons: 0, lessonPrice: 0, averageScore: averageScore(recipient.studentId), grade: "", notes: "" });
        }
      });
    });
    return Array.from(map.values());
  }

  async function run(action) {
    busy = true;
    error = "";
    render();
    try {
      await action();
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
      render();
    }
  }

  function closeModalImmediately() {
    modal = null;
    document.querySelector(".modal-backdrop")?.remove();
  }

  function currentStudent() {
    if (profile?.student) return profile.student;
    const found = students.find((student) => student.userId === user?.id || student.user?.id === user?.id);
    if (found) return found;
    const recipient = assignments.flatMap((assignment) => assignment.recipients).find(Boolean);
    return recipient ? { id: recipient.studentId, user, color: "#3B82F6", averageScore: averageScore(recipient.studentId) } : null;
  }

  function studentName(studentId) {
    const student = students.find((item) => item.id === studentId);
    if (!student) return user?.role === "student" ? `${user.firstName} ${user.lastName}` : "Ученик";
    return `${student.user.firstName} ${student.user.lastName}`;
  }

  function studentById(studentId) {
    return students.find((item) => item.id === studentId) || null;
  }

  function studentInitials(studentId) {
    const student = studentById(studentId);
    const firstName = student?.user?.firstName || (user?.role === "student" ? user.firstName : "У");
    const lastName = student?.user?.lastName || (user?.role === "student" ? user.lastName : "");
    return `${firstName.slice(0, 1)}${lastName.slice(0, 1)}`.toUpperCase();
  }

  function renderStudentAvatar(studentId, className = "student-avatar") {
    const student = studentById(studentId);
    const avatar = student?.user?.avatar || "";
    const color = student?.color || "#3B82F6";
    const name = studentName(studentId);
    return `
      <div class="${className}" style="--avatar-color:${escapeHtml(color)}" aria-label="${escapeHtml(name)}">
        ${avatar ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" />` : `<span>${escapeHtml(studentInitials(studentId))}</span>`}
      </div>
    `;
  }

  function groupName(groupId) {
    const group = groups.find((item) => item.id === groupId);
    return group ? group.name : "Группа";
  }

  function lessonTargetName(lesson) {
    return lesson.groupId ? groupName(lesson.groupId) : studentName(lesson.studentId);
  }

  function lessonTargetColor(lesson) {
    if (lesson.groupId) return groups.find((item) => item.id === lesson.groupId)?.color || "#1267F3";
    return students.find((item) => item.id === lesson.studentId)?.color || "#3B82F6";
  }

  function renderLessonTargetAvatar(lesson, className = "avatar-ring") {
    if (lesson.groupId) {
      return `<div class="${className}" style="--avatar-color:${lessonTargetColor(lesson)}"><span>${escapeHtml(lessonTargetName(lesson).slice(0, 2).toUpperCase())}</span></div>`;
    }
    return renderStudentAvatar(lesson.studentId, className);
  }

  function lessonTargetPaidLessons(lesson) {
    if (lesson.groupId) return groups.find((item) => item.id === lesson.groupId)?.paidLessons ?? 0;
    return students.find((item) => item.id === lesson.studentId)?.paidLessons ?? 0;
  }

  function studentAssignments(studentId) {
    return assignments
      .map((assignment) => ({ ...assignment, recipients: assignment.recipients.filter((recipient) => recipient.studentId === studentId) }))
      .filter((assignment) => assignment.recipients.length > 0);
  }

  function averageScore(studentId) {
    const scores = assignments
      .flatMap((assignment) => assignment.recipients)
      .filter((recipient) => recipient.studentId === studentId && typeof recipient.scorePercent === "number")
      .map((recipient) => recipient.scorePercent);
    if (!scores.length) return 0;
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(value));
  }

  function formatDateTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function scoreClass(score) {
    if (score < 40) return "low";
    if (score < 70) return "mid";
    return "good";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileSize: file.size,
        fileUrl: reader.result
      });
      reader.onerror = () => reject(new Error(`Не удалось прочитать файл ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function readFiles(input) {
    const files = Array.from(input?.files || []);
    if (files.length > MAX_FILES) throw new Error(`Можно прикрепить максимум ${MAX_FILES} файлов.`);
    files.forEach((file) => {
      if (file.size > MAX_FILE_SIZE) throw new Error(`Файл ${file.name} больше 20 МБ.`);
    });
    return Promise.all(files.map(readFileAsDataUrl));
  }

  function renderAttachmentGallery(title, items = []) {
    if (!items.length) return "";
    return `
      <div class="attachment-block">
        <div class="attachment-title">${title}</div>
        <div class="attachment-grid">
          ${items.map((item) => {
            const isImage = item.fileType?.startsWith("image/");
            return `
              <button class="attachment-item" type="button" data-attachment-id="${escapeHtml(item.id)}" title="${escapeHtml(item.fileName)}">
                ${isImage ? `<img src="${escapeHtml(item.fileUrl)}" alt="${escapeHtml(item.fileName)}" />` : `<span class="attachment-file">Файл</span>`}
                <span>${escapeHtml(item.fileName)}</span>
              </button>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function allAttachments() {
    return assignments.flatMap((assignment) => [
      ...(assignment.attachments || []),
      ...(assignment.solutionAttachments || []),
      ...assignment.recipients.flatMap((recipient) => recipient.attachments || [])
    ]);
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  function formatMoney(value) {
    const amount = Number(value || 0);
    return amount ? `${amount.toLocaleString("ru-RU")} ₽` : "не указана";
  }

  function renderAttachmentPreview() {
    if (!previewAttachment) return "";
    const isImage = previewAttachment.fileType?.startsWith("image/");
    const isPdf = previewAttachment.fileType === "application/pdf";
    const canAnnotate = isImage && user.role === "teacher" && previewAttachment.relatedType === "submission";
    const size = formatFileSize(previewAttachment.fileSize);
    return `
      <div class="preview-backdrop">
        <section class="preview-shell" role="dialog" aria-modal="true" aria-label="${escapeHtml(previewAttachment.fileName)}">
          <header class="preview-topbar">
            <div class="preview-file">
              <strong>${escapeHtml(previewAttachment.fileName)}</strong>
              ${size ? `<div class="hint">${escapeHtml(size)}</div>` : ""}
            </div>
            ${canAnnotate ? `
              <div class="annotation-toolbar">
                <div class="annotation-pen">
                  <button class="tool-btn ${annotationTool === "pen" ? "active" : ""}" type="button" data-annotation-tool="pen" aria-expanded="${annotationPenMenuOpen ? "true" : "false"}">Карандаш</button>
                  ${renderAnnotationPenMenu()}
                </div>
                <button class="tool-btn ${annotationTool === "eraser" ? "active" : ""}" type="button" data-annotation-tool="eraser">Ластик</button>
                <button class="tool-btn" type="button" data-action="clear-annotation">Очистить</button>
                <button class="btn" type="button" data-action="save-annotation">Сохранить</button>
              </div>
            ` : ""}
            <button class="btn secondary" data-action="close-preview">Закрыть</button>
          </header>
          <div class="preview-stage">
            ${isImage ? `
              <div class="preview-image-wrap">
                <img class="preview-image" data-preview-image src="${escapeHtml(previewAttachment.fileUrl)}" alt="${escapeHtml(previewAttachment.fileName)}" />
                ${previewAttachment.annotationUrl && !canAnnotate ? `<img class="preview-annotation-image" src="${escapeHtml(previewAttachment.annotationUrl)}" alt="" />` : ""}
                ${canAnnotate ? `<canvas class="annotation-canvas" data-annotation-canvas></canvas>` : ""}
              </div>
            ` : ""}
            ${isPdf ? `<iframe class="preview-frame" src="${escapeHtml(previewAttachment.fileUrl)}" title="${escapeHtml(previewAttachment.fileName)}"></iframe>` : ""}
            ${!isImage && !isPdf ? `
              <div class="preview-empty">
                <h3>${escapeHtml(previewAttachment.fileName)}</h3>
                <a class="btn" href="${escapeHtml(previewAttachment.fileUrl)}" target="_blank" rel="noreferrer">Открыть в браузере</a>
              </div>
            ` : ""}
          </div>
        </section>
      </div>
    `;
  }

  function renderAnnotationPenMenu() {
    const sizes = [
      [4, "Тонкий"],
      [8, "Средний"],
      [14, "Толстый"],
      [22, "Маркер"]
    ];
    return `
      <div class="annotation-pen-menu ${annotationPenMenuOpen ? "open" : ""}">
        <div class="annotation-menu-label">Цвет</div>
        <div class="annotation-colors" aria-label="Цвет карандаша">
          ${renderAnnotationColors()}
        </div>
        <div class="annotation-menu-label">Размер</div>
        <div class="annotation-sizes" aria-label="Размер карандаша">
          ${sizes.map(([size, label]) => `
            <button class="size-swatch ${annotationSize === size ? "active" : ""}" type="button" data-annotation-size="${size}" title="${label}" aria-label="${label}">
              <span style="width:${Math.max(14, size + 8)}px;height:${size}px"></span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderAnnotationColors() {
    const colors = [
      ["#dc2626", "Красный"],
      ["#2563eb", "Синий"],
      ["#16a34a", "Зеленый"],
      ["#f59e0b", "Желтый"],
      ["#7c3aed", "Фиолетовый"],
      ["#111827", "Черный"]
    ];
    return colors.map(([color, label]) => `
      <button
        class="color-swatch ${annotationColor === color ? "active" : ""}"
        type="button"
        data-annotation-color="${color}"
        title="${label}"
        aria-label="${label}"
        style="--swatch-color:${color}"
      ></button>
    `).join("");
  }

  function updateAttachmentInState(updated) {
    allAttachments().forEach((item) => {
      if (item.id === updated.id) Object.assign(item, updated);
    });
    if (previewAttachment?.id === updated.id) Object.assign(previewAttachment, updated);
  }

  function initAnnotationCanvas() {
    const canvas = document.querySelector("[data-annotation-canvas]");
    const image = document.querySelector("[data-preview-image]");
    if (!canvas || !image) return;
    const setup = () => {
      canvas.width = image.naturalWidth || image.clientWidth;
      canvas.height = image.naturalHeight || image.clientHeight;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (previewAttachment.annotationUrl) {
        const annotation = new Image();
        annotation.onload = () => context.drawImage(annotation, 0, 0, canvas.width, canvas.height);
        annotation.src = previewAttachment.annotationUrl;
      }
    };
    if (image.complete) setup();
    else image.addEventListener("load", setup, { once: true });

    const context = canvas.getContext("2d");
    let drawing = false;
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height
      };
    };
    const start = (event) => {
      event.preventDefault();
      drawing = true;
      const current = point(event);
      context.beginPath();
      context.moveTo(current.x, current.y);
    };
    const draw = (event) => {
      if (!drawing) return;
      event.preventDefault();
      const current = point(event);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = annotationTool === "eraser" ? 36 : annotationSize;
      context.strokeStyle = annotationColor;
      context.globalCompositeOperation = annotationTool === "eraser" ? "destination-out" : "source-over";
      context.lineTo(current.x, current.y);
      context.stroke();
    };
    const stop = () => {
      drawing = false;
      context.globalCompositeOperation = "source-over";
    };
    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", draw);
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointerleave", stop);
  }

  async function saveAnnotation() {
    const canvas = document.querySelector("[data-annotation-canvas]");
    if (!canvas || !previewAttachment) return;
    const annotationUrl = canvas.toDataURL("image/png");
    const data = await api(`/api/attachments/${previewAttachment.id}/annotation`, {
      method: "PATCH",
      body: JSON.stringify({ annotationUrl })
    });
    updateAttachmentInState(data.attachment);
    render();
  }

  async function clearAnnotation() {
    const canvas = document.querySelector("[data-annotation-canvas]");
    if (!canvas || !previewAttachment) return;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    const data = await api(`/api/attachments/${previewAttachment.id}/annotation`, {
      method: "PATCH",
      body: JSON.stringify({ annotationUrl: "" })
    });
    updateAttachmentInState(data.attachment);
    render();
  }

  function render() {
    applyTheme();
    const app = document.querySelector("#app");
    if (!user) {
      app.innerHTML = renderLogin();
      bindLogin();
      return;
    }
    app.innerHTML = `
      <div class="app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}">
        <button class="mobile-menu-button" type="button" data-action="open-mobile-sidebar" aria-label="Открыть меню">
          <span></span>
          <span></span>
          <span></span>
        </button>
        <button class="mobile-sidebar-backdrop" type="button" data-action="close-mobile-sidebar" aria-label="Закрыть меню"></button>
        <aside class="sidebar">
          <button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${sidebarCollapsed ? "Развернуть меню" : "Скрыть меню"}">
            <span>${sidebarCollapsed ? "›" : "‹"}</span>
          </button>
          <div class="brand">
            ${renderMascot("small")}
            <div>
              <h1>Математика</h1>
              <div class="hint">${roleLabel()}</div>
            </div>
          </div>
          ${renderSidebarAccount()}
          ${renderNav()}
          ${renderThemeSwitcher()}
          ${renderNotificationSwitcher()}
          <button class="btn secondary sidebar-logout" data-action="logout">Выйти</button>
        </aside>
        <main class="main">
          <section class="content">
            ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
            ${busy ? `<div class="card">Загрузка...</div>` : renderView()}
          </section>
        </main>
      </div>
      ${modal ? renderModal() : ""}
      ${previewAttachment ? renderAttachmentPreview() : ""}
      ${expandedLessonId && view !== "calendar" ? renderLessonOverlay() : ""}
    `;
    bindApp();
  }

  function roleLabel() {
    if (user.role === "teacher") return "Кабинет учителя";
    if (user.role === "parent") return "Кабинет родителя";
    return "Кабинет ученика";
  }

  function renderLogin() {
    return `
      <main class="login-shell">
        <section class="login-panel">
          <div class="login-mascot">${renderMascot("large")}</div>
          <div class="brand">
            ${renderMascot("small")}
            <div>
              <h1>Платформа по математике</h1>
              <div class="hint">Платформа для репетитора по математике</div>
            </div>
          </div>
          ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
          <form id="login-form">
            <div class="field">
              <label>Email</label>
              <input class="input" name="email" autocomplete="email" />
            </div>
            <div class="field">
              <label>Пароль</label>
              <input class="input" name="password" type="password" autocomplete="current-password" />
            </div>
            <button class="btn" type="submit">${busy ? "Входим..." : "Войти"}</button>
          </form>
        </section>
      </main>
    `;
  }

  function renderMascot(size = "small") {
    return `
      <div class="mascot ${size}" aria-hidden="true">
        <div class="owl-body">
          <span class="owl-ear left"></span>
          <span class="owl-ear right"></span>
          <span class="owl-wing left"></span>
          <span class="owl-wing right"></span>
          <span class="owl-eye left"><i></i></span>
          <span class="owl-eye right"><i></i></span>
          <span class="owl-beak"></span>
          <span class="owl-scarf"></span>
          <span class="owl-badge">√x</span>
        </div>
      </div>
    `;
  }

  function renderSidebarAccount() {
    if (user.role === "teacher") {
      return `
        <div class="sidebar-account neutral-account">
          <div class="account-avatar">У</div>
          <div>
            <strong>Кабинет учителя</strong>
            <div class="hint">Рабочее пространство</div>
          </div>
        </div>
      `;
    }
    const accountAttrs = user.role === "student" ? ` data-view="profile" role="button" tabindex="0" aria-label="Редактировать профиль"` : "";
    return `
      <div class="sidebar-account ${user.role === "student" ? "sidebar-account-link" : ""}"${accountAttrs}>
        <div class="account-avatar">${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" />` : `${escapeHtml(user.firstName.slice(0, 1))}${escapeHtml(user.lastName.slice(0, 1))}`}</div>
        <div>
          <strong>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</strong>
          <div class="hint">${escapeHtml(user.email)}</div>
        </div>
      </div>
    `;
  }

  function renderNav() {
    const newAssignmentsCount = user.role === "student"
      ? assignments.reduce((count, assignment) => count + assignment.recipients.filter((recipient) => recipient.status === "new" || recipient.status === "assigned").length, 0)
      : 0;
    const items = user.role === "teacher"
      ? [["dashboard", "Главное", "⌂"], ["calendar", "Календарь", "□"], ["assignments", "ДЗ", "✓"], ["students", "Ученики", "◎"], ["notifications", "Уведомления", "•"]]
      : user.role === "parent"
        ? [["calendar", "Календарь", "□"], ["assignments", "ДЗ", "✓"], ["progress", "Прогресс", "%"]]
        : [["dashboard", "Главное", "⌂"], ["calendar", "Календарь", "□"], ["assignments", "ДЗ", "✓"], ["progress", "Прогресс", "%"], ["notifications", "Уведомления", "•"]];
    return `<nav class="nav">${items.map(([key, label, icon]) => `
      <button class="${view === key ? "active" : ""}" data-view="${key}" title="${escapeHtml(label)}">
        <span class="nav-icon">${icon}</span>
        <span class="nav-label">${label}</span>
        ${key === "assignments" && newAssignmentsCount ? `<span class="nav-badge" aria-label="Новых заданий: ${newAssignmentsCount}">${newAssignmentsCount}</span>` : ""}
      </button>
    `).join("")}</nav>`;
  }

  function renderThemeSwitcher() {
    const themes = [
      ["light", "Белая", "☼"],
      ["dark", "Темная", "◐"],
      ["pink", "Розовая", "✦"]
    ];
    const activeTheme = themes.find(([key]) => key === theme) || themes[0];
    return `
      <div class="theme-switcher ${themeMenuOpen ? "open" : ""}">
        <button class="theme-trigger" type="button" data-action="toggle-theme-menu" aria-expanded="${themeMenuOpen ? "true" : "false"}">
          <span class="theme-icon">${activeTheme[2]}</span>
          <span class="theme-title">
            <small>Тема</small>
            <strong>${activeTheme[1]}</strong>
          </span>
          <span class="theme-chevron">⌄</span>
        </button>
        ${themeMenuOpen ? `
          <div class="theme-menu" aria-label="Тема оформления">
            ${themes.map(([key, label, icon]) => `
              <button class="${theme === key ? "active" : ""}" type="button" data-theme-choice="${key}" aria-pressed="${theme === key ? "true" : "false"}">
                <span>${icon}</span>
                ${label}
              </button>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderNotificationSwitcher() {
    const status = pushState.status;
    const enabled = status === "enabled";
    const androidApp = status === "android-app";
    const blocked = status === "blocked";
    const unsupported = status === "unsupported";
    const serverOff = status === "server-off";
    const checking = status === "checking";
    const message = pushState.message || (enabled ? "Уведомления включены." : "Разрешите уведомления, чтобы получать важные события.");
    const buttonText = checking ? "Проверяем..." : enabled || androidApp ? "Готово" : "Включить";
    return `
      <div class="push-switcher ${enabled || androidApp ? "enabled" : ""} ${blocked || unsupported || serverOff ? "warning" : ""}">
        <div class="push-icon">${enabled || androidApp ? "✓" : "!"}</div>
        <div class="push-copy">
          <strong>Уведомления</strong>
          <span>${escapeHtml(message)}</span>
        </div>
        <button class="push-button" type="button" data-action="enable-notifications" ${enabled || androidApp || checking || unsupported || serverOff ? "disabled" : ""}>
          ${buttonText}
        </button>
      </div>
    `;
  }

  function renderView() {
    if (view === "students") return renderStudents();
    if (view === "assignments") return renderAssignments();
    if (view === "calendar") return renderCalendar();
    if (view === "progress") return renderProgress();
    if (view === "notifications") return renderNotifications();
    if (view === "profile") return renderStudentProfile();
    if (user.role === "teacher") return renderTeacherDashboard();
    if (user.role === "parent") return renderCalendar();
    return renderStudentDashboard();
  }

  function upcomingLessons() {
    const now = new Date();
    return lessons
      .filter((lesson) => new Date(lesson.end || lesson.start) >= now)
      .sort((left, right) => new Date(left.start) - new Date(right.start));
  }

  function metric(label, value, accent = "blue") {
    return `<section class="card metric ${accent}"><span class="muted">${label}</span><strong>${value}</strong></section>`;
  }

  function renderDashboardHero(title, subtitle, actions = "", kicker = "Платформа по математике") {
    return `
      <section class="dashboard-hero">
        <div class="hero-copy">
          <div class="hero-kicker">${escapeHtml(kicker)}</div>
          <h2>${title}</h2>
          <p>${subtitle}</p>
          ${actions ? `<div class="hero-actions">${actions}</div>` : ""}
        </div>
        <div class="hero-visual">
          <div class="formula-cloud">
            <span>y = sin x</span>
            <span>a² + b² = c²</span>
            <span>√x</span>
          </div>
          ${renderMascot("large")}
        </div>
      </section>
    `;
  }

  function renderTeacherDashboard() {
    const submitted = assignments.flatMap((assignment) => assignment.recipients).filter((recipient) => recipient.status === "submitted" || recipient.status === "reviewing").length;
    const upcoming = upcomingLessons();
    return `
      <div class="dashboard-home">
        <div class="grid cols-3 dashboard-metrics">
          ${metric("Ученики", students.length, "blue")}
          ${metric("Группы", groups.length, "green")}
          ${metric("Ожидают проверки", submitted, "amber")}
        </div>
        <div class="grid cols-2 dashboard-info-grid">
          <section class="card dashboard-info-card"><h3>Ближайшие занятия</h3><div class="list">${upcoming.map(renderLessonCard).join("") || "<p>Ближайших занятий пока нет.</p>"}</div></section>
          <section class="card dashboard-info-card"><h3>Работы на проверку</h3><div class="list">${renderReviewQueue()}</div></section>
        </div>
      </div>
    `;
  }

  function renderStudentDashboard() {
    const student = currentStudent();
    const items = student ? studentAssignments(student.id) : assignments;
    const nextLesson = upcomingLessons()[0];
    return `
      <div class="dashboard-home">
        ${renderDashboardHero(`Привет, ${escapeHtml(user.firstName)}!`, "Домашние задания, уведомления и твой прогресс собраны рядом, чтобы было проще двигаться дальше.", `<button class="btn" data-view="assignments">К заданиям</button>`)}
        <div class="grid cols-3 dashboard-metrics">
          ${metric("Активные задания", items.filter((item) => item.recipients.some((recipient) => recipient.status !== "checked")).length, "blue")}
          ${metric("Средний процент", `${student ? averageScore(student.id) : 0}%`, "green")}
          ${metric("Уведомления", notifications.filter((item) => !item.isRead).length, "violet")}
        </div>
        <div class="grid cols-1 dashboard-info-grid">
          <section class="card dashboard-info-card"><h3>Ближайшее занятие</h3>${nextLesson ? renderLessonCard(nextLesson) : "<p>Пока занятий нет.</p>"}</section>
        </div>
      </div>
    `;
  }

  function renderParentDashboard() {
    const student = currentStudent();
    const items = student ? studentAssignments(student.id) : assignments;
    const nextLesson = upcomingLessons()[0];
    const checked = items.flatMap((item) => item.recipients).filter((recipient) => recipient.status === "checked");
    const active = items.flatMap((item) => item.recipients).filter((recipient) => recipient.status !== "checked");
    const studentTitle = student ? studentName(student.id) : "ученика";
    return `
      <div class="dashboard-home parent-dashboard">
        ${renderDashboardHero(
          `Прогресс ${escapeHtml(studentTitle)}`,
          "Здесь собраны занятия, домашние задания, оценки и комментарии учителя, чтобы родителю было понятно, как идут дела.",
          `<button class="btn" data-view="progress">Смотреть графики</button>`,
          "Родительский кабинет"
        )}
        <div class="grid cols-3 dashboard-metrics">
          ${metric("Активные ДЗ", active.length, "blue")}
          ${metric("Средний результат", `${student ? averageScore(student.id) : 0}%`, "green")}
          ${metric("Проверено", checked.length, "violet")}
        </div>
        <div class="grid cols-2 dashboard-info-grid">
          <section class="card dashboard-info-card">
            <h3>Ближайшее занятие</h3>
            ${nextLesson ? renderLessonCard(nextLesson) : "<p>Пока занятий нет.</p>"}
          </section>
          <section class="card dashboard-info-card">
            <h3>Последние результаты</h3>
            <div class="progress-result-list">
              ${items
                .flatMap((assignment) => assignment.recipients.map((recipient) => ({ assignment, recipient })))
                .filter(({ recipient }) => typeof recipient.scorePercent === "number")
                .sort((left, right) => progressDateValue(right) - progressDateValue(left))
                .slice(0, 3)
                .map(renderProgressResult)
                .join("") || "<p>Проверенных работ пока нет.</p>"}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderStudents() {
    return `
      <div class="toolbar">
        <h2>Ученики</h2>
        <div class="row wrap">
          <button class="btn secondary" data-modal="group">Создать группу</button>
          <button class="btn secondary" data-modal="teacher">Добавить учителя</button>
          <button class="btn" data-modal="student">Добавить ученика</button>
        </div>
      </div>
      <section class="card">
        <div class="row wrap">
          <div>
            <h3>Группы</h3>
            <div class="hint">Несколько учеников, с которыми можно работать как с одним адресатом.</div>
          </div>
          <button class="btn secondary" data-modal="group">Новая группа</button>
        </div>
        <div class="group-list">
          ${groups.map(renderGroupCard).join("") || "<p>Групп пока нет.</p>"}
        </div>
      </section>
      <div class="grid cols-2">
        ${students.map((student) => `
          <section class="card">
            <div class="row">
              <div class="student-title">
                ${renderStudentAvatar(student.id)}
                <div>
                  <h3>${studentName(student.id)}</h3>
                  <div class="hint">${escapeHtml(student.grade)}</div>
                </div>
              </div>
              <span class="badge checked">${student.averageScore}%</span>
            </div>
            <p>${escapeHtml(student.notes)}</p>
            <div class="student-work-stats">
              <span>Оплачено уроков: ${student.paidLessons || 0}</span>
              <span>Цена занятия: ${formatMoney(student.lessonPrice)}</span>
              <span>Активные задания: ${studentAssignments(student.id).filter((item) => item.recipients.some((recipient) => recipient.status !== "checked")).length}</span>
            </div>
            <button class="btn secondary" type="button" data-paid-target="student:${escapeHtml(student.id)}">Изменить оплату</button>
          </section>
        `).join("")}
      </div>
    `;
  }

  function renderGroupCard(group) {
    const activeAssignments = group.memberIds.reduce((sum, studentId) => (
      sum + studentAssignments(studentId).filter((item) => item.recipients.some((recipient) => recipient.status !== "checked")).length
    ), 0);
    return `
      <section class="group-card">
        <div class="row wrap">
          <div>
            <h3><span class="student-dot" style="background:${escapeHtml(group.color)}"></span>${escapeHtml(group.name)}</h3>
            <div class="hint">${group.memberIds.length} учеников · активных работ: ${activeAssignments}</div>
          </div>
          <button class="btn secondary" type="button" data-open-group-assignments="${escapeHtml(group.id)}">Открыть работы</button>
        </div>
        ${group.description ? `<p>${escapeHtml(group.description)}</p>` : ""}
        <div class="student-work-stats">
          <span>Оплачено уроков: ${group.paidLessons || 0}</span>
          <button class="btn secondary" type="button" data-paid-target="group:${escapeHtml(group.id)}">Изменить оплату</button>
        </div>
        <div class="group-members">
          ${group.members.map((member) => `<span>${escapeHtml(studentName(member.id))}</span>`).join("")}
        </div>
      </section>
    `;
  }

  function renderAssignments() {
    if (user.role === "teacher") return renderTeacherAssignments();
    return `
      <div class="toolbar assignments-toolbar">
        <h2>Домашние задания</h2>
      </div>
      <div class="list">${assignments.map(renderAssignmentCard).join("") || "<section class='card'>Заданий пока нет.</section>"}</div>
    `;
  }

  function renderTeacherAssignments() {
    if (selectedAssignmentGroupId) {
      const group = groups.find((item) => item.id === selectedAssignmentGroupId);
      const memberIds = group?.memberIds || [];
      const memberSet = new Set(memberIds);
      const items = assignments
        .map((assignment) => ({ ...assignment, recipients: assignment.recipients.filter((recipient) => memberSet.has(recipient.studentId)) }))
        .filter((assignment) => assignment.recipients.length > 0);
      return `
        <div class="toolbar">
          <div>
            <h2>${group ? escapeHtml(group.name) : "Группа"}</h2>
            <div class="hint">Домашние задания участников группы</div>
          </div>
          <div class="row wrap">
            <button class="btn secondary" data-action="back-assignment-students">Назад к ученикам и группам</button>
            <button class="btn" data-modal="assignment">Создать задание</button>
          </div>
        </div>
        <div class="list">${items.map(renderAssignmentCard).join("") || "<section class='card'>У группы пока нет домашних заданий.</section>"}</div>
      `;
    }

    if (selectedAssignmentStudentId) {
      const student = students.find((item) => item.id === selectedAssignmentStudentId);
      const items = studentAssignments(selectedAssignmentStudentId);
      return `
        <div class="toolbar">
          <div>
            <h2>${student ? studentName(student.id) : "Ученик"}</h2>
            <div class="hint">Домашние задания ученика</div>
          </div>
          <div class="row wrap">
            <button class="btn secondary" data-action="back-assignment-students">Назад к ученикам и группам</button>
            <button class="btn" data-modal="assignment">Создать задание</button>
          </div>
        </div>
        <div class="list">${items.map(renderAssignmentCard).join("") || "<section class='card'>У ученика пока нет домашних заданий.</section>"}</div>
      `;
    }

    return `
      <div class="toolbar assignments-toolbar">
        <h2>Домашние задания</h2>
        <button class="btn" data-modal="assignment">Создать задание</button>
      </div>
      <div class="grid cols-2">
        ${groups.map(renderAssignmentGroupCard).join("")}
        ${students.map(renderAssignmentStudentCard).join("")}
        ${!groups.length && !students.length ? "<section class='card'>Учеников и групп пока нет.</section>" : ""}
      </div>
    `;
  }

  function renderAssignmentGroupCard(group) {
    const memberSet = new Set(group.memberIds);
    const items = assignments
      .map((assignment) => ({ ...assignment, recipients: assignment.recipients.filter((recipient) => memberSet.has(recipient.studentId)) }))
      .filter((assignment) => assignment.recipients.length > 0);
    const recipients = items.flatMap((assignment) => assignment.recipients);
    const reviewCount = recipients.filter((recipient) => recipient.status === "submitted" || recipient.status === "reviewing").length;
    const checkedCount = recipients.filter((recipient) => recipient.status === "checked").length;
    return `
      <button class="card assignment-student-card group-target-card" type="button" data-assignment-group="${escapeHtml(group.id)}">
        <div class="row">
          <div>
            <h3><span class="student-dot" style="background:${escapeHtml(group.color)}"></span>${escapeHtml(group.name)}</h3>
            <div class="hint">${group.memberIds.length} учеников</div>
          </div>
          <span class="badge">${items.length} работ</span>
        </div>
        <div class="student-work-stats">
          <span>На проверке: ${reviewCount}</span>
          <span>Проверено: ${checkedCount}</span>
        </div>
      </button>
    `;
  }

  function renderAssignmentStudentCard(student) {
    const items = studentAssignments(student.id);
    const recipients = items.flatMap((assignment) => assignment.recipients);
    const reviewCount = recipients.filter((recipient) => recipient.status === "submitted" || recipient.status === "reviewing").length;
    const checkedCount = recipients.filter((recipient) => recipient.status === "checked").length;
    return `
      <button class="card assignment-student-card" type="button" data-assignment-student="${escapeHtml(student.id)}">
        <div class="row">
          <div class="student-title">
            ${renderStudentAvatar(student.id)}
            <div>
              <h3>${studentName(student.id)}</h3>
              <div class="hint">${escapeHtml(student.grade)}</div>
            </div>
          </div>
          <span class="badge">${items.length} работ</span>
        </div>
        <div class="student-work-stats">
          <span>На проверке: ${reviewCount}</span>
          <span>Проверено: ${checkedCount}</span>
        </div>
      </button>
    `;
  }

  function renderAssignmentCard(assignment) {
    return `
      <section class="card">
        <div class="row wrap">
          <div>
            <h3>${escapeHtml(assignment.title)}</h3>
            <div class="hint">Дедлайн: ${formatDate(assignment.dueDate)}</div>
          </div>
          <div class="row wrap">
            ${assignment.recipients.map((recipient) => `<span class="badge ${recipient.status}">${statusLabels[recipient.status] || recipient.status}</span>`).join("")}
          </div>
        </div>
        <p>${escapeHtml(assignment.description)}</p>
        ${renderAttachmentGallery("Материалы задания", assignment.attachments)}
        ${user.role === "teacher" ? renderAttachmentGallery("Решение учителя", assignment.solutionAttachments) : ""}
        ${assignment.recipients.map((recipient) => `
          <div class="subpanel">
            <div class="row wrap">
              <div class="student-title student-title-top">
                ${renderStudentAvatar(recipient.studentId, "student-avatar compact")}
                <div>
                  <strong>${studentName(recipient.studentId)}</strong>
                  <div class="hint">${recipient.studentComment ? escapeHtml(recipient.studentComment) : "Комментария ученика пока нет"}</div>
                </div>
                ${recipient.textAnswer ? `<p>${escapeHtml(recipient.textAnswer)}</p>` : ""}
                ${renderAttachmentGallery("Решение ученика", recipient.attachments)}
              </div>
              ${renderAssignmentActions(assignment.id, recipient)}
            </div>
            ${typeof recipient.scorePercent === "number" ? renderProgressBar(assignment, recipient) + renderTeacherComment(recipient) : ""}
          </div>
        `).join("")}
      </section>
    `;
  }

  function renderTeacherComment(recipient) {
    if (!recipient.teacherComment) return "";
    return `
      <div class="teacher-comment">
        <span>Комментарий учителя</span>
        <p>${escapeHtml(recipient.teacherComment)}</p>
      </div>
    `;
  }

  function renderAssignmentActions(assignmentId, recipient) {
    if (user.role === "student" && recipient.status !== "checked") {
      const hasSubmittedWork = Boolean(recipient.submittedAt || recipient.textAnswer || recipient.attachments?.length);
      return `<button class="btn" data-submit="${assignmentId}">${hasSubmittedWork ? "Изменить" : "Отправить решение"}</button>`;
    }
    if (user.role === "teacher" && (recipient.status === "submitted" || recipient.status === "reviewing")) {
      return `<button class="btn" data-check="${assignmentId}:${recipient.studentId}">Проверить</button>`;
    }
    return "";
  }

  function renderProgressBar(assignment, recipient) {
    const score = recipient.scorePercent;
    const points = recipient.scorePoints;
    const maxScore = recipient.scoreMax || assignment.maxScore;
    const scoreText = typeof points === "number" && typeof maxScore === "number" ? `${points}/${maxScore}` : `${score}%`;
    return `
      <div class="score-summary">
        <div>
          <span>Выставленные баллы</span>
          <strong>${scoreText}</strong>
        </div>
        <b>${score}%</b>
      </div>
      <div class="progress ${scoreClass(score)}" style="--value:${score}%"><span></span></div>
    `;
  }

  function renderReviewQueue() {
    const items = [];
    assignments.forEach((assignment) => {
      assignment.recipients.forEach((recipient) => {
        if (recipient.status === "submitted" || recipient.status === "reviewing") {
          items.push(`
            <div class="row">
              <span class="student-title compact-row">
                ${renderStudentAvatar(recipient.studentId, "student-avatar compact")}
                <span>${escapeHtml(assignment.title)} - ${studentName(recipient.studentId)}</span>
              </span>
              <button class="btn secondary" data-check="${assignment.id}:${recipient.studentId}">Открыть</button>
            </div>
          `);
        }
      });
    });
    return items.length ? items.join("") : "<p>Нет работ, ожидающих проверки.</p>";
  }

  function dateKey(value) {
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function timeLabel(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function getCalendarMonth() {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth() + calendarMonthOffset, 1);
  }

  function buildCalendarDays(monthDate) {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const leadingDays = (firstDay.getDay() + 6) % 7;
    const totalCells = Math.ceil((leadingDays + lastDay.getDate()) / 7) * 7;
    const start = new Date(year, month, 1 - leadingDays);
    return Array.from({ length: totalCells }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }

  function calendarTargetValue(lesson) {
    return lesson.groupId ? `group:${lesson.groupId}` : `student:${lesson.studentId}`;
  }

  function calendarStatusValue(lesson) {
    return lesson.conductedAt ? "conducted" : "planned";
  }

  function filteredCalendarLessons(source = lessons) {
    const query = calendarSearch.trim().toLowerCase();
    return source.filter((lesson) => {
      if (user.role === "teacher" && calendarStudentFilter !== "all" && calendarTargetValue(lesson) !== calendarStudentFilter) return false;
      if (calendarFormatFilter !== "all" && lesson.format !== calendarFormatFilter) return false;
      if (calendarStatusFilter !== "all" && calendarStatusValue(lesson) !== calendarStatusFilter) return false;
      if (!query) return true;
      if (user.role !== "teacher") {
        return [lesson.topic, lesson.title].some((value) => String(value || "").toLowerCase().includes(query));
      }
      return [
        lesson.topic,
        lesson.title,
        lesson.comment,
        lesson.meetingUrl,
        lessonTargetName(lesson)
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }

  function getCalendarAnchorDate() {
    const monthDate = getCalendarMonth();
    const now = new Date();
    if (calendarMonthOffset === 0) return now;
    return monthDate;
  }

  function renderCalendarEvent(lesson) {
    const conducted = Boolean(lesson.conductedAt);
    return `
      <button class="calendar-event ${conducted ? "conducted" : ""}" type="button" data-lesson-id="${escapeHtml(lesson.id)}" title="${escapeHtml(lesson.topic || lesson.title)}" style="--event-color:${lessonTargetColor(lesson)}">
        <span class="calendar-event-dot" style="background:${lessonTargetColor(lesson)}"></span>
        <span class="calendar-event-time">${timeLabel(lesson.start)}</span>
        <span class="calendar-event-title">${escapeHtml(lessonTargetName(lesson))}</span>
        ${conducted ? `<span class="conducted-mark">Проведено</span>` : ""}
      </button>
    `;
  }

  function renderMonthCalendar(visibleLessons) {
    const monthDate = getCalendarMonth();
    const currentMonth = monthDate.getMonth();
    const todayKey = dateKey(new Date());
    const days = buildCalendarDays(monthDate);
    const lessonsByDay = visibleLessons.reduce((map, lesson) => {
      const key = dateKey(lesson.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(lesson);
      return map;
    }, new Map());
    const weekDays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

    return `
      <section class="calendar-board">
        <div class="calendar-grid">
          ${weekDays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
          ${days.map((day) => {
            const key = dateKey(day);
            const dayLessons = (lessonsByDay.get(key) || []).sort((left, right) => new Date(left.start) - new Date(right.start));
            const classes = [
              "calendar-day",
              day.getMonth() !== currentMonth ? "muted-day" : "",
              key === todayKey ? "today" : "",
              key === selectedCalendarDate ? "selected-day" : "",
              dayLessons.length ? "has-events" : ""
            ].filter(Boolean).join(" ");
            const dayAttrs = user.role === "teacher" ? ` data-lesson-date="${key}" role="button" tabindex="0" aria-label="Добавить занятие ${formatDate(day)}"` : "";
            return `
              <div class="${classes}"${dayAttrs}>
                <div class="calendar-date">${day.getDate()}</div>
                <div class="calendar-events">
                  ${dayLessons.slice(0, 3).map(renderCalendarEvent).join("")}
                  ${dayLessons.length > 3 ? `<div class="calendar-more">+${dayLessons.length - 3} ещё</div>` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function renderWeekCalendar(visibleLessons) {
    const anchor = getCalendarAnchorDate();
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
    const lessonsByDay = visibleLessons.reduce((map, lesson) => {
      const key = dateKey(lesson.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(lesson);
      return map;
    }, new Map());
    return `
      <section class="calendar-board calendar-week-board">
        ${days.map((day) => {
          const key = dateKey(day);
          const dayLessons = (lessonsByDay.get(key) || []).sort((left, right) => new Date(left.start) - new Date(right.start));
          return `
            <div class="week-column" ${user.role === "teacher" ? `data-lesson-date="${key}" role="button" tabindex="0"` : ""}>
              <div class="week-column-head">
                <span>${new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(day)}</span>
                <strong>${day.getDate()}</strong>
              </div>
              <div class="week-column-events">
                ${dayLessons.map(renderCalendarEvent).join("") || "<p>Нет занятий</p>"}
              </div>
            </div>
          `;
        }).join("")}
      </section>
    `;
  }

  function renderDayCalendar(visibleLessons) {
    const anchor = getCalendarAnchorDate();
    const key = dateKey(anchor);
    const dayLessons = visibleLessons
      .filter((lesson) => dateKey(lesson.start) === key)
      .sort((left, right) => new Date(left.start) - new Date(right.start));
    return `
      <section class="calendar-board calendar-day-board" ${user.role === "teacher" ? `data-lesson-date="${key}" role="button" tabindex="0"` : ""}>
        <div class="day-board-head">
          <span>${new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(anchor)}</span>
          <strong>${formatDate(anchor)}</strong>
        </div>
        <div class="day-board-list">
          ${dayLessons.map(renderDayAgendaItem).join("") || "<p>На этот день занятий нет.</p>"}
        </div>
      </section>
    `;
  }

  function renderDayAgendaItem(lesson) {
    const conducted = Boolean(lesson.conductedAt);
    return `
      <button class="day-agenda-item ${conducted ? "conducted" : ""}" type="button" data-lesson-id="${escapeHtml(lesson.id)}" style="--event-color:${lessonTargetColor(lesson)}">
        <span>${timeLabel(lesson.start)} - ${timeLabel(lesson.end)}</span>
        <strong>${escapeHtml(lesson.topic || lesson.title)}</strong>
        <em>${escapeHtml(lessonTargetName(lesson))}</em>
      </button>
    `;
  }

  function renderCalendarBody(visibleLessons) {
    if (calendarViewMode === "week") return renderWeekCalendar(visibleLessons);
    if (calendarViewMode === "day") return renderDayCalendar(visibleLessons);
    return renderMonthCalendar(visibleLessons);
  }

  function renderCalendar() {
    const visibleLessons = filteredCalendarLessons();
    const upcoming = upcomingLessons().filter((lesson) => visibleLessons.some((item) => item.id === lesson.id));
    const monthDate = getCalendarMonth();
    const currentMonth = monthDate.getMonth();
    const monthLessons = visibleLessons.filter((lesson) => {
      const lessonDate = new Date(lesson.start);
      return lessonDate.getFullYear() === monthDate.getFullYear() && lessonDate.getMonth() === currentMonth;
    });
    const selectedDateLessons = selectedCalendarDate
      ? visibleLessons
        .filter((lesson) => dateKey(lesson.start) === selectedCalendarDate)
        .sort((left, right) => new Date(left.start) - new Date(right.start))
      : [];
    const selectedLesson = calendarDetailsHidden
      ? null
      : visibleLessons.find((item) => item.id === expandedLessonId) || selectedDateLessons[0] || upcoming[0] || monthLessons[0] || visibleLessons[0];
    const monthLabel = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(monthDate);
    const canGoNext = calendarMonthOffset < 1;
    const targetOptions = [
      `<option value="all">Все ученики</option>`,
      ...students.map((student) => `<option value="student:${student.id}" ${calendarStudentFilter === `student:${student.id}` ? "selected" : ""}>${studentName(student.id)}</option>`),
      ...groups.map((group) => `<option value="group:${group.id}" ${calendarStudentFilter === `group:${group.id}` ? "selected" : ""}>${escapeHtml(group.name)} · группа</option>`)
    ].join("");
    const plannedStatusLabel = user.role !== "teacher" ? "Не проведено" : "Запланировано";
    const searchPlaceholder = user.role !== "teacher" ? "Поиск по названию урока..." : "Поиск по занятиям...";
    const createLessonButton = user.role === "teacher"
      ? `<button class="btn calendar-create-btn" data-modal="lesson">+ Создать урок</button>`
      : "";
    const calendarDetailPanel = calendarDetailsHidden
      ? ""
      : selectedCalendarDate ? renderCalendarDayPanel(selectedCalendarDate, selectedDateLessons) : renderCalendarDetail(selectedLesson);
    const calendarUpcomingPanel = user.role === "teacher" ? `<section class="calendar-upcoming-card">
      <div class="row">
        <h3>Ближайшие занятия</h3>
        <span class="hint">Смотреть все</span>
      </div>
      <div class="calendar-upcoming-list">${upcoming.slice(0, 4).map(renderUpcomingCalendarItem).join("") || "<p>Ближайших занятий пока нет.</p>"}</div>
    </section>` : "";
    const calendarSidePanel = calendarDetailPanel || calendarUpcomingPanel
      ? `<aside class="calendar-side-panel">${calendarDetailPanel}${calendarUpcomingPanel}</aside>`
      : "";
    return `
      <div class="calendar-page ${calendarSidePanel ? "" : "without-side-panel"}">
        <section class="calendar-main-panel">
          <div class="calendar-titlebar">
            <div>
              <h2>Календарь</h2>
              <div class="hint">${monthLessons.length ? `${monthLessons.length} занятий в этом месяце` : "В этом месяце занятий нет"}</div>
            </div>
            ${createLessonButton}
          </div>
          <div class="calendar-controlbar">
            <div class="calendar-switcher">
              <button class="icon-btn" type="button" data-calendar-shift="-1" aria-label="Предыдущий месяц">‹</button>
              <button class="icon-btn" type="button" data-calendar-shift="1" aria-label="Следующий месяц" ${canGoNext ? "" : "disabled"}>›</button>
            </div>
            <button class="btn secondary calendar-today" type="button" data-calendar-today>Сегодня</button>
            <div class="calendar-month-label"><span class="calendar-mini-icon">▦</span>${monthLabel}</div>
            <div class="calendar-view-tabs" aria-label="Вид календаря">
              <button class="${calendarViewMode === "month" ? "active" : ""}" type="button" data-calendar-view-mode="month">Месяц</button>
              <button class="${calendarViewMode === "week" ? "active" : ""}" type="button" data-calendar-view-mode="week">Неделя</button>
              <button class="${calendarViewMode === "day" ? "active" : ""}" type="button" data-calendar-view-mode="day">День</button>
            </div>
            <button class="btn secondary calendar-filter-btn ${calendarFiltersVisible ? "active" : ""}" type="button" data-calendar-filter-toggle>Фильтры</button>
          </div>
          <div class="calendar-filterbar ${user.role !== "teacher" ? "student-calendar-filters" : ""} ${calendarFiltersVisible ? "" : "hidden"}">
            ${user.role === "teacher" ? `<select class="select" aria-label="Ученики" data-calendar-filter="student">${targetOptions}</select>` : ""}
            <select class="select" aria-label="Форматы" data-calendar-filter="format">
              <option value="all">Все форматы</option>
              <option value="online" ${calendarFormatFilter === "online" ? "selected" : ""}>Онлайн</option>
              <option value="offline" ${calendarFormatFilter === "offline" ? "selected" : ""}>Офлайн</option>
            </select>
            <select class="select" aria-label="Статусы" data-calendar-filter="status">
              <option value="all">Все статусы</option>
              <option value="planned" ${calendarStatusFilter === "planned" ? "selected" : ""}>${plannedStatusLabel}</option>
              <option value="conducted" ${calendarStatusFilter === "conducted" ? "selected" : ""}>Проведено</option>
            </select>
            <label class="calendar-search"><span>⌕</span><input class="input" data-calendar-search type="search" value="${escapeHtml(calendarSearch)}" placeholder="${searchPlaceholder}" /></label>
          </div>
          ${renderCalendarBody(visibleLessons)}
        </section>
        ${calendarSidePanel}
      </div>
    `;
  }

  function renderCalendarDetail(lesson) {
    if (!lesson) {
      return `
        <section class="calendar-detail-card">
          <div class="row"><h3>Выбранное занятие</h3></div>
          <p>Выберите занятие в календаре, чтобы увидеть подробности.</p>
        </section>
      `;
    }
    const conducted = Boolean(lesson.conductedAt);
    const format = lesson.format === "online" ? "Онлайн-занятие" : "Офлайн-занятие";
    return `
      <section class="calendar-detail-card">
        <div class="row">
          <h3>Выбранное занятие</h3>
          <button class="icon-btn close-side" type="button" data-action="clear-calendar-selection" aria-label="Снять выбор">×</button>
        </div>
        <span class="badge ${conducted ? "checked" : "assigned"}">${conducted ? "Проведено" : "Запланировано"}</span>
        <div class="calendar-detail-student">
          ${renderLessonTargetAvatar(lesson)}
          <div>
            <strong>${escapeHtml(lessonTargetName(lesson))}</strong>
            <div class="hint">${lesson.groupId ? "Группа" : "Индивидуальное занятие"}</div>
          </div>
        </div>
        <div class="calendar-detail-topic">
          <span>Тема занятия</span>
          <strong>${escapeHtml(lesson.topic || lesson.title)}</strong>
        </div>
        <div class="calendar-detail-list">
          <span>▦ ${formatDate(lesson.start)}</span>
          <span>◷ ${timeLabel(lesson.start)} - ${timeLabel(lesson.end)}</span>
          <span>▣ ${format}</span>
          ${lesson.meetingUrl ? `<span>↗ <a href="${escapeHtml(lesson.meetingUrl)}" target="_blank" rel="noreferrer">${escapeHtml(lesson.meetingUrl)}</a></span>` : ""}
          ${lesson.format === "online" && !lesson.meetingUrl ? `<span class="lesson-link-warning">Ссылка на онлайн-занятие не указана</span>` : ""}
        </div>
        ${lesson.comment ? `<div class="calendar-detail-notes"><span>Заметки</span><p>${escapeHtml(lesson.comment)}</p></div>` : ""}
        ${user.role === "teacher" ? `
          <button class="btn secondary wide" type="button" data-lesson-conducted="${escapeHtml(lesson.id)}:${conducted ? "0" : "1"}">${conducted ? "Отменить проведение" : "Отметить проведённым"}</button>
        ` : ""}
      </section>
    `;
  }

  function renderCalendarDayPanel(dateValue, dayLessons) {
    const date = new Date(`${dateValue}T00:00:00`);
    return `
      <section class="calendar-detail-card selected-day-card">
        <div class="row">
          <div>
            <h3>Уроки дня</h3>
            <div class="hint">${formatDate(date)} · ${dayLessons.length} уроков</div>
          </div>
          <button class="icon-btn close-side" type="button" data-action="clear-calendar-day" aria-label="Снять выбор дня">×</button>
        </div>
        <div class="selected-day-lessons">
          ${dayLessons.map(renderSelectedDayLesson).join("") || "<p>На этот день уроков пока нет.</p>"}
        </div>
        ${user.role === "teacher" ? `<button class="btn wide" type="button" data-create-lesson-date="${escapeHtml(dateValue)}">+ Создать урок на эту дату</button>` : ""}
      </section>
    `;
  }

  function renderSelectedDayLesson(lesson) {
    const conducted = Boolean(lesson.conductedAt);
    return `
      <button class="selected-day-lesson ${conducted ? "conducted" : ""}" type="button" data-lesson-id="${escapeHtml(lesson.id)}" style="--event-color:${lessonTargetColor(lesson)}">
        <div>
          <strong>${timeLabel(lesson.start)} · ${escapeHtml(lessonTargetName(lesson))}</strong>
          <span>${escapeHtml(lesson.topic || lesson.title)} · ${lesson.format === "online" ? "онлайн" : "офлайн"}</span>
        </div>
        <span class="badge ${conducted ? "checked" : "assigned"}">${conducted ? "Проведено" : "План"}</span>
      </button>
    `;
  }

  function renderUpcomingCalendarItem(lesson) {
    const conducted = Boolean(lesson.conductedAt);
    return `
      <button class="calendar-upcoming-item ${conducted ? "conducted" : ""}" type="button" data-lesson-id="${escapeHtml(lesson.id)}">
        <div>
          <strong>${escapeHtml(lessonTargetName(lesson))}</strong>
          <span>Тема: ${escapeHtml(lesson.topic || lesson.title)}</span>
        </div>
        <div>
          <b>${timeLabel(lesson.start)}</b>
          <span>${lesson.format === "online" ? "Онлайн" : "Офлайн"}</span>
        </div>
      </button>
    `;
  }

  function renderLessonCard(lesson) {
    const conducted = Boolean(lesson.conductedAt);
    return `
      <button class="card lesson" type="button" data-lesson-id="${escapeHtml(lesson.id)}">
        <div class="row wrap">
          <div>
            <h3>${escapeHtml(lesson.topic || lesson.title)}</h3>
            <div class="hint">${formatDateTime(lesson.start)} - ${formatDateTime(lesson.end)} · ${lesson.format === "online" ? "онлайн" : "офлайн"}</div>
          </div>
          <div class="row wrap">
            <span class="badge ${conducted ? "checked" : "assigned"}">${conducted ? "Проведено" : "Запланировано"}</span>
            <div class="student-title compact-row">${renderLessonTargetAvatar(lesson, "student-avatar tiny")}${escapeHtml(lessonTargetName(lesson))}</div>
          </div>
        </div>
        ${lesson.meetingUrl ? `<p>${escapeHtml(lesson.meetingUrl)}</p>` : ""}
        ${lesson.comment ? `<p>${escapeHtml(lesson.comment)}</p>` : ""}
      </button>
    `;
  }

  function renderLessonOverlay() {
    const lesson = lessons.find((item) => item.id === expandedLessonId);
    if (!lesson) return "";
    const format = lesson.format === "online" ? "онлайн" : "офлайн";
    const targetLabel = lesson.groupId ? "Группа" : "Ученик";
    const conducted = Boolean(lesson.conductedAt);
    return `
      <div class="lesson-backdrop">
        <section class="lesson-expanded" role="dialog" aria-modal="true" aria-label="${escapeHtml(lesson.topic || lesson.title)}">
          <div class="row wrap lesson-expanded-head">
            <div>
              <div class="hint">Занятие</div>
              <h2>${escapeHtml(lesson.topic || lesson.title)}</h2>
            </div>
            <div class="row wrap">
              ${user.role === "teacher" ? `<button class="btn ${conducted ? "secondary" : ""}" data-lesson-conducted="${escapeHtml(lesson.id)}:${conducted ? "0" : "1"}">${conducted ? "Отменить проведение" : "Отметить проведённым"}</button>` : ""}
              <button class="btn secondary" data-action="close-lesson">Закрыть</button>
            </div>
          </div>
          <div class="lesson-expanded-grid">
            <div class="lesson-detail">
              <span>${targetLabel}</span>
              <strong class="student-title compact-row">${renderLessonTargetAvatar(lesson, "student-avatar tiny")}${escapeHtml(lessonTargetName(lesson))}</strong>
            </div>
            <div class="lesson-detail">
              <span>Дата и время</span>
              <strong>${formatDateTime(lesson.start)} - ${formatDateTime(lesson.end)}</strong>
            </div>
            <div class="lesson-detail">
              <span>Формат</span>
              <strong>${format}</strong>
            </div>
            <div class="lesson-detail">
              <span>Оплачено осталось</span>
              <strong>${lessonTargetPaidLessons(lesson)}</strong>
            </div>
            <div class="lesson-detail">
              <span>Статус</span>
              <strong>${conducted ? `Проведено${lesson.chargedLessons ? " · списан 1 урок" : ""}` : "Запланировано"}</strong>
            </div>
            ${lesson.location ? `<div class="lesson-detail"><span>Место</span><strong>${escapeHtml(lesson.location)}</strong></div>` : ""}
          </div>
          ${lesson.meetingUrl ? `<div class="lesson-section"><span>Ссылка</span><a href="${escapeHtml(lesson.meetingUrl)}" target="_blank" rel="noreferrer">${escapeHtml(lesson.meetingUrl)}</a></div>` : ""}
          ${lesson.comment ? `<div class="lesson-section"><span>Комментарий</span><p>${escapeHtml(lesson.comment)}</p></div>` : ""}
        </section>
      </div>
    `;
  }

  function renderProgress() {
    const student = currentStudent();
    const items = student ? studentAssignments(student.id) : assignments;
    const records = items.flatMap((assignment) => assignment.recipients.map((recipient) => ({ assignment, recipient })));
    const scored = records
      .filter(({ recipient }) => typeof recipient.scorePercent === "number")
      .sort((left, right) => progressDateValue(right) - progressDateValue(left));
    const checked = records.filter(({ recipient }) => recipient.status === "checked");
    const overdue = records.filter(({ recipient }) => recipient.status === "overdue");
    const active = records.filter(({ recipient }) => recipient.status !== "checked" && recipient.status !== "overdue");
    const average = scored.length
      ? Math.round(scored.reduce((sum, { recipient }) => sum + recipient.scorePercent, 0) / scored.length)
      : 0;
    const best = scored.reduce((current, record) => {
      if (!current) return record;
      return record.recipient.scorePercent > current.recipient.scorePercent ? record : current;
    }, null);
    const overdueAssignment = overdue[0]?.assignment || null;
    const recentTrend = [...scored].sort((left, right) => progressDateValue(left) - progressDateValue(right)).slice(-10);
    const latest = scored.slice(0, 5);
    const title = user.role === "parent" && student ? `Прогресс: ${studentName(student.id)}` : student ? "Личный прогресс" : "Прогресс учеников";
    return `
      <div class="toolbar progress-toolbar">
        <div>
          <h2>${title}</h2>
        </div>
      </div>
      <div class="grid cols-3 progress-metrics">
        ${metric("Средний результат", `${average}%`, average >= 70 ? "green" : average >= 40 ? "amber" : "red")}
        ${metric("Проверено работ", checked.length)}
        ${metric("В работе", active.length)}
      </div>
      <section class="card progress-overview-card">
        <div class="progress-dial" style="--value:${average}%">
          <div>
            <strong>${average}%</strong>
            <span>средний результат</span>
          </div>
        </div>
        <div class="progress-overview-copy">
          <h3>${user.role === "parent" && student ? `Картина по учебе: ${escapeHtml(studentName(student.id))}` : student ? `${escapeHtml(user.firstName)}, вот твоя картина по учебе` : "Картина по проверенным работам"}</h3>
          <p>${progressSummaryText(scored.length, average, overdueAssignment)}</p>
          <div class="progress-highlight-row">
            <span>Лучший результат</span>
            <strong>${best ? `${best.recipient.scorePercent}% · ${escapeHtml(best.assignment.title)}` : "Пока нет оценок"}</strong>
          </div>
          ${overdueAssignment ? `
            <div class="progress-highlight-row overdue-work-row">
              <span>У тебя просроченная работа</span>
              <strong>${escapeHtml(overdueAssignment.title)}</strong>
            </div>
          ` : ""}
        </div>
      </section>
      <div class="grid cols-2 progress-grid">
        <section class="card progress-chart-card">
          <div class="row wrap">
            <div>
              <h3>Динамика результатов</h3>
              <div class="hint">Последние 10 проверенных работ по порядку. График можно пролистывать.</div>
            </div>
          </div>
          ${renderProgressTrend(recentTrend)}
        </section>
        <section class="card progress-status-card">
          <h3>Состояние работ</h3>
          ${renderProgressStatus(records, checked.length, active.length, overdue.length)}
        </section>
      </div>
      <section class="card progress-results-card">
        <h3>Последние оценки</h3>
        <div class="progress-result-list">
          ${latest.map(renderProgressResult).join("") || "<div class='progress-empty'>Проверенных работ пока нет. Когда учитель выставит баллы, здесь появится история результатов.</div>"}
        </div>
      </section>
    `;
  }

  function progressDateValue(record) {
    const value = record.recipient.checkedAt || record.recipient.submittedAt || record.assignment.dueDate || record.assignment.createdAt || "";
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function progressSummaryText(scoredCount, average, overdueAssignment) {
    if (!scoredCount) return "Пока нет проверенных работ, поэтому прогресс будет собираться после первых оценок.";
    if (overdueAssignment) return `У тебя просроченная работа: ${escapeHtml(overdueAssignment.title)}`;
    if (average >= 85) return "Очень сильная динамика: можно держать темп и постепенно брать задания сложнее.";
    if (average >= 70) return "Прогресс устойчивый. Хорошо бы смотреть на комментарии учителя и добирать недостающие баллы.";
    if (average >= 40) return "Есть база, но результаты пока неровные. Самые полезные точки роста видны в комментариях к работам.";
    return "Сейчас важнее не скорость, а регулярность: разбирать ошибки и закрывать работы небольшими шагами.";
  }

  function renderProgressTrend(records) {
    if (!records.length) return "<div class='progress-empty'>Динамика появится после проверки нескольких работ.</div>";
    return `
      <div class="progress-chart-scroll" tabindex="0" aria-label="График последних результатов">
        <div class="progress-chart" style="--chart-columns:${records.length}">
          ${records.map(({ assignment, recipient }) => `
            <div class="progress-chart-column">
              <div class="progress-chart-bar ${scoreClass(recipient.scorePercent)}" style="height:${Math.max(58, Math.round(recipient.scorePercent * 1.65))}px">
                <span>${recipient.scorePercent}%</span>
              </div>
              <small title="${escapeHtml(assignment.title)}">${escapeHtml(assignment.title)}</small>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderProgressStatus(records, checkedCount, activeCount, overdueCount) {
    const total = records.length || 1;
    const rows = [
      ["Проверено", checkedCount, "checked"],
      ["В работе", activeCount, "active"],
      ["Просрочено", overdueCount, "overdue"]
    ];
    return `
      <div class="progress-status-list">
        ${rows.map(([label, value, kind]) => `
          <div class="progress-status-row">
            <div>
              <span>${label}</span>
              <strong>${value}</strong>
            </div>
            <div class="progress ${kind}" style="--value:${Math.round((value / total) * 100)}%"><span></span></div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderProgressResult({ assignment, recipient }) {
    const score = recipient.scorePercent;
    const maxScore = recipient.scoreMax || assignment.maxScore;
    const scoreText = typeof recipient.scorePoints === "number" && typeof maxScore === "number"
      ? `${recipient.scorePoints}/${maxScore}`
      : `${score}%`;
    return `
      <article class="progress-result-row">
        <div>
          <h4>${escapeHtml(assignment.title)}</h4>
          <div class="hint">${formatDate(recipient.checkedAt || recipient.submittedAt || assignment.dueDate)}</div>
          ${recipient.teacherComment ? `<p class="progress-teacher-note">${escapeHtml(recipient.teacherComment)}</p>` : ""}
        </div>
        <div class="progress-result-score ${scoreClass(score)}">
          <strong>${scoreText}</strong>
          <span>${score}%</span>
        </div>
      </article>
    `;
  }

  function renderStudentProfile() {
    if (user.role !== "student") return renderTeacherDashboard();
    const student = currentStudent();
    const initials = `${user.firstName.slice(0, 1)}${user.lastName.slice(0, 1)}`;
    return `
      <div class="profile-page">
        <div class="toolbar profile-toolbar">
          <div>
            <h2>Личный профиль</h2>
          </div>
        </div>
        <section class="card profile-card">
          <form id="profile-form" class="profile-form">
            <div class="profile-avatar-panel">
              <div class="profile-avatar-preview" data-profile-avatar-preview>
                ${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" />` : `<span>${escapeHtml(initials)}</span>`}
              </div>
              <div>
                <h3>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</h3>
                <div class="hint">${escapeHtml(user.email)}</div>
                <label class="btn secondary avatar-upload">
                  Изменить аватарку
                  <input name="avatarFile" type="file" accept="image/*" />
                </label>
              </div>
              <input type="hidden" name="avatar" value="${escapeHtml(user.avatar || "")}" />
            </div>
            <div class="form-grid">
              <div class="field"><label>Имя</label><input class="input" name="firstName" value="${escapeHtml(user.firstName)}" required /></div>
              <div class="field"><label>Фамилия</label><input class="input" name="lastName" value="${escapeHtml(user.lastName)}" required /></div>
              <div class="field"><label>Email</label><input class="input" value="${escapeHtml(user.email)}" disabled /></div>
              <div class="field"><label>Телефон</label><input class="input" name="phone" value="${escapeHtml(user.phone || "")}" /></div>
              <div class="field wide"><label>О себе</label><textarea class="textarea" name="bio" placeholder="Например: что нравится в математике, цели, удобное время для занятий...">${escapeHtml(student?.bio || "")}</textarea></div>
              <button class="btn wide" type="submit">Сохранить профиль</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderNotifications() {
    return `
      <div class="toolbar">
        <h2>Уведомления</h2>
        <button class="btn secondary" data-action="read-all">Отметить прочитанными</button>
      </div>
      <div class="list">
        ${notifications.map((item) => `
          <section class="card notification-card ${item.relatedType === "assignment_overdue" ? "overdue-notification" : ""}">
            <div class="row">
              <div>
                <h3>${escapeHtml(item.title)}</h3>
                <div class="hint">${formatDateTime(item.createdAt)} ${item.isRead ? "" : "· не прочитано"}</div>
              </div>
              ${item.relatedType === "assignment_overdue" ? `<span class="badge overdue">Просрочка</span>` : item.isRead ? "" : `<span class="badge new">Новое</span>`}
            </div>
            <p>${escapeHtml(item.message)}</p>
          </section>
        `).join("") || "<section class='card'>Уведомлений пока нет.</section>"}
      </div>
    `;
  }

  function renderModal() {
    if (modal === "teacher") return modalShell("Добавить учителя", `
      <form id="teacher-form" class="form-grid">
        ${field("firstName", "Имя")}
        ${field("lastName", "Фамилия")}
        ${field("email", "Email", "email")}
        <div class="field">
          <label>Пароль учителя</label>
          <input class="input" name="password" type="text" placeholder="Например: Teacher123!" required />
        </div>
        ${field("phone", "Телефон")}
        <button class="btn wide" type="submit">Создать учителя</button>
      </form>
    `);
    if (modal === "student") return modalShell("Добавить ученика", `
      <form id="student-form" class="form-grid">
        ${field("firstName", "Имя")}
        ${field("lastName", "Фамилия")}
        ${field("email", "Email", "email")}
        <div class="field">
          <label>Пароль ученика</label>
          <input class="input" name="password" type="text" placeholder="Например: Student123!" required />
        </div>
        ${field("phone", "Телефон")}
        ${field("grade", "Класс")}
        ${field("paidLessons", "Оплачено уроков", "number")}
        ${field("lessonPrice", "Цена занятия", "number")}
        <div class="field wide">
          <label>Постоянная ссылка на онлайн-урок</label>
          <input class="input" name="meetingUrl" type="url" placeholder="https://..." required />
        </div>
        ${field("notes", "Заметки", "textarea", "wide")}
        <div class="form-divider wide">Родительский доступ</div>
        <div class="field"><label>Имя родителя</label><input class="input" name="parentFirstName" /></div>
        <div class="field"><label>Фамилия родителя</label><input class="input" name="parentLastName" /></div>
        <div class="field"><label>Email родителя</label><input class="input" name="parentEmail" type="email" /></div>
        <div class="field"><label>Пароль родителя</label><input class="input" name="parentPassword" type="text" placeholder="Например: Parent123!" /></div>
        <div class="field"><label>Телефон родителя</label><input class="input" name="parentPhone" /></div>
        <div class="field"><label>Кем приходится</label><input class="input" name="parentRelation" placeholder="Мама, папа, опекун" /></div>
        <button class="btn wide" type="submit">Создать ученика</button>
      </form>
    `);
    if (modal === "group") return modalShell("Создать группу", `
      <form id="group-form" class="form-grid">
        ${field("name", "Название группы")}
        <div class="field"><label>Цвет</label><input class="input" name="color" type="color" value="#1267F3" /></div>
        ${field("paidLessons", "Оплачено уроков", "number")}
        <div class="field wide"><label>Ученики</label><select class="select" name="studentIds" multiple required>${students.map((student) => `<option value="${student.id}" selected>${studentName(student.id)}</option>`).join("")}</select></div>
        ${field("description", "Описание", "textarea", "wide")}
        <button class="btn wide" type="submit">Создать группу</button>
      </form>
    `);
    if (modal?.startsWith("paid:")) {
      const [, targetType, targetId] = modal.split(":");
      const target = targetType === "group"
        ? groups.find((item) => item.id === targetId)
        : students.find((item) => item.id === targetId);
      const title = targetType === "group" ? groupName(targetId) : studentName(targetId);
      return modalShell("Оплаченные уроки", `
        <form id="paid-lessons-form" class="form-grid">
          <div class="field wide">
            <label>${escapeHtml(title)}</label>
            <input class="input" name="paidLessons" type="number" min="0" value="${escapeHtml(target?.paidLessons || 0)}" required />
          </div>
          ${targetType === "student" ? `
            <div class="field wide">
              <label>Цена занятия</label>
              <input class="input" name="lessonPrice" type="number" min="0" value="${escapeHtml(target?.lessonPrice || 0)}" />
            </div>
          ` : ""}
          <button class="btn wide" type="submit">Сохранить</button>
        </form>
      `);
    }
    if (modal === "assignment") {
      const hasTargetContext = Boolean(selectedAssignmentStudentId || selectedAssignmentGroupId);
      const studentOptions = students.map((student) => {
        const selected = selectedAssignmentStudentId
          ? student.id === selectedAssignmentStudentId
          : !hasTargetContext;
        return `<option value="${student.id}" ${selected ? "selected" : ""}>${studentName(student.id)}</option>`;
      }).join("");
      const groupOptions = groups.map((group) => `<option value="${group.id}" ${group.id === selectedAssignmentGroupId ? "selected" : ""}>${escapeHtml(group.name)} · ${group.memberIds.length} учеников</option>`).join("");
      return modalShell("Создать задание", `
      <form id="assignment-form" class="form-grid">
        ${field("title", "Название")}
        ${field("dueDate", "Дедлайн", "date")}
        <div class="field wide"><label>Ученики</label><select class="select" name="studentIds" multiple>${studentOptions}</select></div>
        <div class="field wide"><label>Группы</label><select class="select" name="groupIds" multiple>${groupOptions}</select></div>
        ${field("description", "Описание и LaTeX", "textarea", "wide")}
        ${field("maxScore", "Максимальный балл", "number")}
        <div class="field wide upload-box">
          <label>Фото/файлы задания</label>
          <input class="input" name="attachments" type="file" accept="image/*,.pdf,.doc,.docx,.txt,.zip" multiple />
          <div class="hint">Можно прикрепить фото условия, PDF или документ.</div>
        </div>
        <div class="field wide upload-box">
          <label>Решение учителя для проверки</label>
          <input class="input" name="solutionAttachments" type="file" accept="image/*,.pdf,.doc,.docx,.txt,.zip" multiple />
          <div class="hint">Эти файлы видит учитель, чтобы сверяться при проверке.</div>
        </div>
        <button class="btn wide" type="submit">Назначить</button>
      </form>
    `);
    }
    if (modal === "lesson") {
      const startValue = selectedLessonDate ? `${selectedLessonDate}T15:00` : "";
      const endValue = selectedLessonDate ? `${selectedLessonDate}T16:00` : "";
      const targetOptions = [
        ...students.map((student) => `<option value="student:${student.id}">${studentName(student.id)}</option>`),
        ...groups.map((group) => `<option value="group:${group.id}">${escapeHtml(group.name)} · группа</option>`)
      ].join("");
      return modalShell("Создать урок", `
      <form id="lesson-form" class="form-grid">
        <div class="field"><label>Ученик или группа</label><select class="select" name="targetId">${targetOptions}</select></div>
        ${field("topic", "Тема")}
        <div class="field"><label>Начало</label><input class="input" name="start" type="datetime-local" value="${escapeHtml(startValue)}" required /></div>
        <div class="field"><label>Окончание</label><input class="input" name="end" type="datetime-local" value="${escapeHtml(endValue)}" required /></div>
        <div class="field"><label>Формат</label><select class="select" name="format"><option value="online">Онлайн</option><option value="offline">Офлайн</option></select></div>
        <div class="field">
          <label>Ссылка на встречу</label>
          <input class="input" name="meetingUrl" type="url" placeholder="https://..." />
          <div class="hint">Для индивидуального онлайн-урока можно оставить пустым: подставится ссылка ученика.</div>
        </div>
        ${field("comment", "Комментарий", "textarea", "wide")}
        <button class="btn wide" type="submit">Сохранить урок</button>
      </form>
    `);
    }
    if (modal?.startsWith("submit:")) return modalShell("Отправить решение", `
      <form id="submit-form" class="grid">
        ${field("textAnswer", "Текстовый ответ", "textarea")}
        ${field("studentComment", "Комментарий")}
        <div class="field upload-box">
          <label>Фото решения</label>
          <input class="input" name="attachments" type="file" accept="image/*,.pdf,.doc,.docx,.txt,.zip" capture="environment" multiple />
          <div class="hint">Можно прикрепить фотографии из тетради или файл.</div>
        </div>
        <button class="btn" type="submit">Отправить на проверку</button>
      </form>
    `);
    if (modal?.startsWith("check:")) {
      const [, assignmentId] = modal.split(":");
      const assignment = assignments.find((item) => item.id === assignmentId);
      const maxScore = assignment?.maxScore || 100;
      return modalShell("Проверить работу", `
      <form id="check-form" class="form-grid">
        <div class="field"><label>Набрано баллов</label><input class="input" name="scorePoints" type="number" min="0" max="${escapeHtml(maxScore)}" required /></div>
        <div class="field"><label>Максимум баллов</label><input class="input" name="scoreMax" type="number" min="1" value="${escapeHtml(maxScore)}" required /></div>
        <div class="field"><label>Статус</label><select class="select" name="status"><option value="checked">Проверено</option><option value="revision">Нужно исправить</option></select></div>
        ${field("teacherComment", "Комментарий учителя", "textarea", "wide")}
        <button class="btn wide" type="submit">Сохранить проверку</button>
      </form>
    `);
    }
    return "";
  }

  function modalShell(title, body) {
    return `<div class="modal-backdrop"><section class="modal"><div class="row"><h2>${title}</h2><button class="btn secondary" data-action="close-modal">Закрыть</button></div>${body}</section></div>`;
  }

  function field(name, label, type = "text", extraClass = "") {
    if (type === "textarea") return `<div class="field ${extraClass}"><label>${label}</label><textarea class="textarea" name="${name}"></textarea></div>`;
    return `<div class="field ${extraClass}"><label>${label}</label><input class="input" name="${name}" type="${type}" /></div>`;
  }

  function bindLogin() {
    const form = document.querySelector("#login-form");
    if (!form) return;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      run(async () => {
        const response = await api("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
        token = response.token;
        user = response.user;
        localStorage.setItem(TOKEN_KEY, token);
        syncAndroidAuthToken();
        await loadData();
      });
    });
  }

  function bindApp() {
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      view = button.dataset.view;
      modal = null;
      previewAttachment = null;
      expandedLessonId = null;
      mobileSidebarOpen = false;
      themeMenuOpen = false;
      if (view === "assignments") {
        selectedAssignmentStudentId = "";
        selectedAssignmentGroupId = "";
      }
      render();
    }));
    document.querySelectorAll("[role='button'][data-view]").forEach((button) => button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      button.click();
    }));
    document.querySelectorAll("[data-modal]").forEach((button) => button.addEventListener("click", () => {
      modal = button.dataset.modal;
      if (modal === "lesson") selectedLessonDate = "";
      render();
    }));
    document.querySelectorAll("[data-lesson-date]").forEach((button) => button.addEventListener("click", () => {
      selectedCalendarDate = button.dataset.lessonDate;
      expandedLessonId = null;
      calendarDetailsHidden = false;
      render();
    }));
    document.querySelectorAll("[data-create-lesson-date]").forEach((button) => button.addEventListener("click", () => {
      selectedLessonDate = button.dataset.createLessonDate;
      modal = "lesson";
      render();
    }));
    document.querySelectorAll("[data-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
      const shift = Number(button.dataset.calendarShift || 0);
      calendarMonthOffset = Math.min(1, calendarMonthOffset + shift);
      selectedLessonDate = "";
      expandedLessonId = null;
      selectedCalendarDate = "";
      calendarDetailsHidden = false;
      render();
    }));
    document.querySelectorAll("[data-calendar-today]").forEach((button) => button.addEventListener("click", () => {
      calendarMonthOffset = 0;
      selectedLessonDate = "";
      expandedLessonId = null;
      calendarDetailsHidden = false;
      render();
    }));
    document.querySelectorAll("[data-calendar-view-mode]").forEach((button) => button.addEventListener("click", () => {
      calendarViewMode = button.dataset.calendarViewMode;
      expandedLessonId = null;
      selectedCalendarDate = "";
      calendarDetailsHidden = false;
      render();
    }));
    document.querySelectorAll("[data-calendar-filter]").forEach((select) => select.addEventListener("change", () => {
      if (select.dataset.calendarFilter === "student") calendarStudentFilter = select.value;
      if (select.dataset.calendarFilter === "format") calendarFormatFilter = select.value;
      if (select.dataset.calendarFilter === "status") calendarStatusFilter = select.value;
      expandedLessonId = null;
      selectedCalendarDate = "";
      calendarDetailsHidden = false;
      render();
    }));
    document.querySelectorAll("[data-calendar-search]").forEach((input) => {
      input.addEventListener("input", () => {
        calendarSearch = input.value;
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        expandedLessonId = null;
        selectedCalendarDate = "";
        calendarDetailsHidden = false;
        render();
      });
      input.addEventListener("change", () => {
        calendarSearch = input.value;
        expandedLessonId = null;
        selectedCalendarDate = "";
        calendarDetailsHidden = false;
        render();
      });
    });
    document.querySelectorAll("[data-calendar-filter-toggle]").forEach((button) => button.addEventListener("click", () => {
      calendarFiltersVisible = !calendarFiltersVisible;
      render();
    }));
    document.querySelectorAll("[data-submit]").forEach((button) => button.addEventListener("click", () => {
      modal = `submit:${button.dataset.submit}`;
      render();
    }));
    document.querySelectorAll("[data-check]").forEach((button) => button.addEventListener("click", () => {
      modal = `check:${button.dataset.check}`;
      render();
    }));
    document.querySelectorAll("[data-assignment-student]").forEach((button) => button.addEventListener("click", () => {
      selectedAssignmentStudentId = button.dataset.assignmentStudent;
      selectedAssignmentGroupId = "";
      render();
    }));
    document.querySelectorAll("[data-assignment-group]").forEach((button) => button.addEventListener("click", () => {
      selectedAssignmentGroupId = button.dataset.assignmentGroup;
      selectedAssignmentStudentId = "";
      render();
    }));
    document.querySelectorAll("[data-open-group-assignments]").forEach((button) => button.addEventListener("click", () => {
      selectedAssignmentGroupId = button.dataset.openGroupAssignments;
      selectedAssignmentStudentId = "";
      view = "assignments";
      render();
    }));
    document.querySelectorAll("[data-paid-target]").forEach((button) => button.addEventListener("click", () => {
      modal = `paid:${button.dataset.paidTarget}`;
      render();
    }));
    document.querySelectorAll("[data-action='back-assignment-students']").forEach((button) => button.addEventListener("click", () => {
      selectedAssignmentStudentId = "";
      selectedAssignmentGroupId = "";
      render();
    }));
    document.querySelectorAll("[data-action='close-modal']").forEach((button) => button.addEventListener("click", () => {
      modal = null;
      selectedLessonDate = "";
      render();
    }));
    document.querySelectorAll("[data-attachment-id]").forEach((button) => button.addEventListener("click", () => {
      previewAttachment = allAttachments().find((item) => item.id === button.dataset.attachmentId) || null;
      render();
    }));
    document.querySelectorAll("[data-action='close-preview']").forEach((button) => button.addEventListener("click", () => {
      previewAttachment = null;
      render();
    }));
    document.querySelectorAll("[data-annotation-tool]").forEach((button) => button.addEventListener("click", () => {
      annotationTool = button.dataset.annotationTool;
      annotationPenMenuOpen = annotationTool === "pen" ? !annotationPenMenuOpen : false;
      document.querySelectorAll("[data-annotation-tool]").forEach((item) => item.classList.toggle("active", item.dataset.annotationTool === annotationTool));
      document.querySelector(".annotation-pen-menu")?.classList.toggle("open", annotationPenMenuOpen);
      document.querySelector("[data-annotation-tool='pen']")?.setAttribute("aria-expanded", annotationPenMenuOpen ? "true" : "false");
    }));
    document.querySelectorAll("[data-annotation-color]").forEach((button) => button.addEventListener("click", () => {
      annotationColor = button.dataset.annotationColor;
      annotationTool = "pen";
      document.querySelectorAll("[data-annotation-tool]").forEach((item) => item.classList.toggle("active", item.dataset.annotationTool === annotationTool));
      document.querySelectorAll("[data-annotation-color]").forEach((item) => item.classList.toggle("active", item.dataset.annotationColor === annotationColor));
    }));
    document.querySelectorAll("[data-annotation-size]").forEach((button) => button.addEventListener("click", () => {
      annotationSize = Number(button.dataset.annotationSize || 8);
      annotationTool = "pen";
      document.querySelectorAll("[data-annotation-tool]").forEach((item) => item.classList.toggle("active", item.dataset.annotationTool === annotationTool));
      document.querySelectorAll("[data-annotation-size]").forEach((item) => item.classList.toggle("active", Number(item.dataset.annotationSize || 8) === annotationSize));
    }));
    document.querySelectorAll("[data-action='save-annotation']").forEach((button) => button.addEventListener("click", () => {
      button.disabled = true;
      saveAnnotation().catch((err) => {
        error = err.message;
        render();
      });
    }));
    document.querySelectorAll("[data-action='clear-annotation']").forEach((button) => button.addEventListener("click", () => {
      button.disabled = true;
      clearAnnotation().catch((err) => {
        error = err.message;
        render();
      });
    }));
    document.querySelectorAll("[data-lesson-id]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedLessonId = button.dataset.lessonId;
      selectedCalendarDate = "";
      calendarDetailsHidden = false;
      render();
    }));
    document.querySelectorAll("[data-action='clear-calendar-selection']").forEach((button) => button.addEventListener("click", () => {
      expandedLessonId = null;
      selectedCalendarDate = "";
      calendarDetailsHidden = true;
      render();
    }));
    document.querySelectorAll("[data-action='clear-calendar-day']").forEach((button) => button.addEventListener("click", () => {
      selectedCalendarDate = "";
      expandedLessonId = null;
      calendarDetailsHidden = true;
      render();
    }));
    document.querySelectorAll("[data-action='close-lesson']").forEach((button) => button.addEventListener("click", () => {
      expandedLessonId = null;
      render();
    }));
    document.querySelectorAll("[data-action='toggle-sidebar']").forEach((button) => button.addEventListener("click", () => {
      sidebarCollapsed = !sidebarCollapsed;
      themeMenuOpen = false;
      render();
    }));
    document.querySelectorAll("[data-action='open-mobile-sidebar']").forEach((button) => button.addEventListener("click", () => {
      mobileSidebarOpen = true;
      themeMenuOpen = false;
      render();
    }));
    document.querySelectorAll("[data-action='close-mobile-sidebar']").forEach((button) => button.addEventListener("click", () => {
      mobileSidebarOpen = false;
      themeMenuOpen = false;
      render();
    }));
    document.querySelectorAll("[data-action='toggle-theme-menu']").forEach((button) => button.addEventListener("click", () => {
      themeMenuOpen = !themeMenuOpen;
      render();
    }));
    document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => {
      theme = button.dataset.themeChoice;
      themeMenuOpen = false;
      localStorage.setItem(THEME_KEY, theme);
      render();
    }));
    document.querySelectorAll("[data-action='enable-notifications']").forEach((button) => button.addEventListener("click", () => {
      button.disabled = true;
      pushState = { status: "checking", message: "Включаем уведомления..." };
      render();
      enablePushNotifications({ askPermission: true })
        .then(() => render())
        .catch((err) => {
          pushState = { status: "error", message: err.message || "Не удалось включить уведомления." };
          render();
        });
    }));
    document.querySelectorAll("[data-lesson-conducted]").forEach((button) => button.addEventListener("click", () => {
      const [lessonId, conducted] = button.dataset.lessonConducted.split(":");
      run(async () => {
        await api(`/api/lessons/${lessonId}/conducted`, { method: "PATCH", body: JSON.stringify({ conducted: conducted === "1" }) });
        await loadData();
      });
    }));
    document.querySelectorAll("[data-action='logout']").forEach((button) => button.addEventListener("click", () => {
      run(async () => {
        await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
        localStorage.removeItem(TOKEN_KEY);
        token = null;
        syncAndroidAuthToken();
        user = null;
        students = [];
        groups = [];
        assignments = [];
        lessons = [];
        notifications = [];
        profile = null;
        pushState = { status: "idle", message: "" };
        view = "dashboard";
        previewAttachment = null;
        expandedLessonId = null;
        selectedLessonDate = "";
        selectedCalendarDate = "";
        calendarMonthOffset = 0;
        calendarViewMode = "month";
        calendarFiltersVisible = true;
        calendarStudentFilter = "all";
        calendarFormatFilter = "all";
        calendarStatusFilter = "all";
        calendarSearch = "";
        selectedAssignmentStudentId = "";
        selectedAssignmentGroupId = "";
        sidebarCollapsed = false;
      });
    }));
    document.querySelectorAll("[data-action='read-all']").forEach((button) => button.addEventListener("click", () => {
      run(async () => {
        await api("/api/notifications/read-all", { method: "POST", body: "{}" });
        await loadData();
      });
    }));
    bindForms();
    initAnnotationCanvas();
  }

  function bindForms() {
    const teacherForm = document.querySelector("#teacher-form");
    if (teacherForm) teacherForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      run(async () => {
        await api("/api/teachers", { method: "POST", body: JSON.stringify(data) });
        modal = null;
        await loadData();
      });
    });

    const studentForm = document.querySelector("#student-form");
    if (studentForm) studentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      run(async () => {
        await api("/api/students", { method: "POST", body: JSON.stringify(data) });
        modal = null;
        view = "students";
        await loadData();
      });
    });

    const groupForm = document.querySelector("#group-form");
    if (groupForm) groupForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      data.studentIds = Array.from(form.elements.studentIds.selectedOptions).map((option) => option.value);
      run(async () => {
        await api("/api/groups", { method: "POST", body: JSON.stringify(data) });
        modal = null;
        view = "students";
        await loadData();
      });
    });

    const paidLessonsForm = document.querySelector("#paid-lessons-form");
    if (paidLessonsForm) paidLessonsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const [, targetType, targetId] = modal.split(":");
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const path = targetType === "group"
        ? `/api/groups/${targetId}/paid-lessons`
        : `/api/students/${targetId}/paid-lessons`;
      run(async () => {
        await api(path, { method: "PATCH", body: JSON.stringify(data) });
        modal = null;
        await loadData();
      });
    });

    const profileForm = document.querySelector("#profile-form");
    if (profileForm) {
      const avatarInput = profileForm.elements.avatarFile;
      avatarInput?.addEventListener("change", async () => {
        try {
          const file = avatarInput.files?.[0];
          if (!file) return;
          if (!file.type.startsWith("image/")) throw new Error("Выберите изображение для аватарки.");
          if (file.size > MAX_FILE_SIZE) throw new Error("Аватарка больше 20 МБ.");
          const item = await readFileAsDataUrl(file);
          profileForm.elements.avatar.value = item.fileUrl;
          const preview = document.querySelector("[data-profile-avatar-preview]");
          if (preview) preview.innerHTML = `<img src="${escapeHtml(item.fileUrl)}" alt="" />`;
        } catch (err) {
          error = err.message;
          render();
        }
      });
      profileForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        delete data.avatarFile;
        run(async () => {
          const response = await api("/api/profile", { method: "PATCH", body: JSON.stringify(data) });
          user = response.user;
          profile = response;
          await loadData();
          view = "profile";
        });
      });
    }

    const assignmentForm = document.querySelector("#assignment-form");
    if (assignmentForm) assignmentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      data.studentIds = Array.from(form.elements.studentIds.selectedOptions).map((option) => option.value);
      data.groupIds = form.elements.groupIds ? Array.from(form.elements.groupIds.selectedOptions).map((option) => option.value) : [];
      const attachmentInput = form.elements.attachments;
      const solutionAttachmentInput = form.elements.solutionAttachments;
      closeModalImmediately();
      run(async () => {
        data.attachments = await readFiles(attachmentInput);
        data.solutionAttachments = await readFiles(solutionAttachmentInput);
        await api("/api/assignments", { method: "POST", body: JSON.stringify(data) });
        view = "assignments";
        await loadData();
      });
    });

    const lessonForm = document.querySelector("#lesson-form");
    if (lessonForm) lessonForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const [targetType, targetId] = String(data.targetId || "").split(":");
      delete data.targetId;
      if (targetType === "group") data.groupId = targetId;
      else data.studentId = targetId;
      run(async () => {
        await api("/api/lessons", { method: "POST", body: JSON.stringify(data) });
        modal = null;
        selectedLessonDate = "";
        view = "calendar";
        await loadData();
      });
    });

    const submitForm = document.querySelector("#submit-form");
    if (submitForm) submitForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const assignmentId = modal.split(":")[1];
      const data = Object.fromEntries(new FormData(form));
      const attachmentInput = form.elements.attachments;
      closeModalImmediately();
      run(async () => {
        data.attachments = await readFiles(attachmentInput);
        await api(`/api/assignments/${assignmentId}/submit`, { method: "POST", body: JSON.stringify(data) });
        view = "assignments";
        await loadData();
      });
    });

    const checkForm = document.querySelector("#check-form");
    if (checkForm) checkForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const [, assignmentId, studentId] = modal.split(":");
      const data = Object.fromEntries(new FormData(event.currentTarget));
      data.studentId = studentId;
      run(async () => {
        await api(`/api/assignments/${assignmentId}/check`, { method: "POST", body: JSON.stringify(data) });
        modal = null;
        view = "assignments";
        await loadData();
      });
    });
  }

  registerServiceWorker();
  bootstrap();
})();


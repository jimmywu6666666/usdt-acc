(function () {
  const toast = document.getElementById("toast");
  const inviteUrl = new URLSearchParams(window.location.search).get("invite") || "";

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(window.__adToastTimer);
    window.__adToastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 1700);
  }

  async function copyText(id) {
    const baseText = document.getElementById(id).innerText.trim();
    const text = inviteUrl ? `${baseText}\n\n开户链接：${inviteUrl}` : baseText;
    await navigator.clipboard.writeText(text);
    showToast(inviteUrl ? "文案已复制，已带专属链接" : "文案已复制");
  }

  async function copyImage(src) {
    if (!window.ClipboardItem || !navigator.clipboard?.write) {
      throw new Error("当前浏览器不支持复制图片");
    }

    const response = await fetch(src, { cache: "no-store" });
    if (!response.ok) throw new Error("图片读取失败");
    const blob = await response.blob();
    const pngBlob = blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    showToast("图片已复制");
  }

  document.addEventListener("click", (event) => {
    const imageTarget = event.target.closest("[data-copy-image]");
    const textTarget = event.target.closest("[data-copy-text]");

    if (imageTarget) {
      copyImage(imageTarget.dataset.copyImage).catch(() => showToast("复制图片失败，请下载海报后上传"));
    }

    if (textTarget) {
      copyText(textTarget.dataset.copyText).catch(() => showToast("复制失败，请手动选择文案"));
    }
  });
}());

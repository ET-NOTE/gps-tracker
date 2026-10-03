const accepted = ["image/png", "image/jpeg", "image/webp"];
export async function uploadPostImage(file, signal) {
  if (!accepted.includes(file.type))
    throw new Error("PNG·JPEG·WebP 사진만 넣을 수 있습니다.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("사진 한 장은 10MB 이하로 선택해 주세요.");
  signal.throwIfAborted();
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("사진을 읽지 못했습니다. 다른 파일로 다시 시도해 주세요.");
  }
  let blob;
  try {
    signal.throwIfAborted();
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.86),
    );
    canvas.width = canvas.height = 1;
  } finally {
    bitmap.close();
  }
  if (!blob || blob.size > 2 * 1024 * 1024)
    throw new Error(
      "사진 용량을 줄이지 못했습니다. 더 작은 사진을 선택해 주세요.",
    );
  signal.throwIfAborted();
  const response = await fetch("/api/admin/post-images", {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": blob.type },
    body: blob,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error ||
        (response.status === 413
          ? "사진 용량이 너무 큽니다."
          : "사진을 올리지 못했습니다. 잠시 후 다시 시도해 주세요."),
    );
  return data;
}

// A step and its photos move together; removing a step preserves its photos at
// the previous insertion point so a text edit cannot silently delete an image.
export function moveStep(content, from, to) {
  const steps = [...content.steps];
  [steps[from], steps[to]] = [steps[to], steps[from]];
  const titles = content.step_titles?.length ? [...content.step_titles] : [];
  if (titles.length) [titles[from], titles[to]] = [titles[to], titles[from]];
  const position = (x) => ({
    ...x,
    after_step:
      x.after_step === from + 1
        ? to + 1
        : x.after_step === to + 1
          ? from + 1
          : x.after_step,
  });
  return {
    ...content,
    steps,
    step_titles: titles,
    images: (content.images || []).map(position),
    attachments: (content.attachments || []).map(position),
  };
}
export function removeStep(content, index) {
  const position = (x) => ({
    ...x,
    after_step: x.after_step > index ? x.after_step - 1 : x.after_step,
  });
  return {
    ...content,
    steps: content.steps.filter((_, i) => i !== index),
    step_titles: (content.step_titles || []).filter((_, i) => i !== index),
    images: (content.images || []).map(position),
    attachments: (content.attachments || []).map(position),
  };
}

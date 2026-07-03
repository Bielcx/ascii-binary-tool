"""
segmentation.py

Gera a mascara (silhueta) de cada frame.

Estrategia:
  1. Tenta rembg (u2net_human_seg) - segmentacao por IA, mais precisa,
     entende que e uma pessoa. Precisa de internet na PRIMEIRA vez que
     roda (baixa o modelo, ~176mb, fica em cache depois).
  2. Se o rembg falhar (sem modelo, sem internet, etc), cai automaticamente
     pra segmentacao por diferenca de movimento compensada por camera
     (classica, sem IA, funciona offline sempre).

O objetivo do fallback e o app nunca "travar" so porque a IA nao estava
disponivel - sempre devolve alguma mascara, e o usuario ajusta com o
pincel se precisar.
"""

import cv2
import numpy as np

_rembg_session = None
_rembg_available = None


def _try_load_rembg():
    global _rembg_session, _rembg_available
    if _rembg_available is not None:
        return _rembg_available
    try:
        from rembg import new_session
        _rembg_session = new_session("u2net_human_seg")
        _rembg_available = True
    except Exception as e:
        print(f"[segmentation] rembg indisponivel, usando fallback por movimento: {e}")
        _rembg_available = False
    return _rembg_available


def segment_with_rembg(frame_bgr: np.ndarray) -> np.ndarray:
    from rembg import remove
    from PIL import Image
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(rgb)
    result = remove(pil_img, session=_rembg_session, only_mask=True)
    mask = np.array(result)
    if mask.ndim == 3:
        mask = mask[:, :, 0]
    return mask


# ---- fallback: diferenca de movimento compensada por homografia ----

_orb = cv2.ORB_create(3000)
_bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)


def _estimate_homography(g_from, g_to):
    kp1, des1 = _orb.detectAndCompute(g_from, None)
    kp2, des2 = _orb.detectAndCompute(g_to, None)
    if des1 is None or des2 is None or len(des1) < 10 or len(des2) < 10:
        return None
    matches = _bf.match(des1, des2)
    matches = sorted(matches, key=lambda x: x.distance)[:300]
    if len(matches) < 20:
        return None
    src = np.float32([kp1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([kp2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    H, _ = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    return H


def segment_with_motion(frames: list[np.ndarray], idx: int) -> np.ndarray:
    h, w = frames[idx].shape[:2]
    ref_idx = idx - 1 if idx > 0 else min(idx + 1, len(frames) - 1)
    if ref_idx == idx:
        return np.zeros((h, w), dtype=np.uint8)

    g_ref = cv2.cvtColor(frames[ref_idx], cv2.COLOR_BGR2GRAY)
    g_cur = cv2.cvtColor(frames[idx], cv2.COLOR_BGR2GRAY)
    H = _estimate_homography(g_ref, g_cur)
    if H is None:
        return np.zeros((h, w), dtype=np.uint8)

    warped = cv2.warpPerspective(frames[ref_idx], H, (w, h))
    diff = cv2.absdiff(cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY), g_cur)
    _, th = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))

    contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask = np.zeros((h, w), dtype=np.uint8)
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:2]:
        if cv2.contourArea(c) > 800:
            cv2.drawContours(mask, [c], -1, 255, -1)
    return cv2.dilate(mask, np.ones((9, 9), np.uint8))


def _merge_person_and_motion(person_mask: np.ndarray, motion_mask: np.ndarray) -> np.ndarray:
    """Junta a pessoa do rembg com movimento conectado/proximo (ex: skate)."""
    person = (person_mask > 30).astype(np.uint8) * 255
    motion = (motion_mask > 30).astype(np.uint8) * 255
    if cv2.countNonZero(person) == 0:
        return motion
    if cv2.countNonZero(motion) == 0:
        return person

    h, w = person.shape[:2]
    merged = person.copy()

    # expande a pessoa para aceitar objetos colados ou muito proximos dela.
    # O skate costuma ficar logo abaixo dos pes, entao usamos uma dilatacao
    # vertical um pouco maior que a horizontal.
    near_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(15, w // 22), max(25, h // 12)))
    near_person = cv2.dilate(person, near_kernel, iterations=1)

    contours, _ = cv2.findContours(motion, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        area = cv2.contourArea(c)
        if area < 120:
            continue
        component = np.zeros_like(person)
        cv2.drawContours(component, [c], -1, 255, -1)
        touches_person = cv2.countNonZero(cv2.bitwise_and(component, near_person)) > 0
        if touches_person:
            merged = cv2.bitwise_or(merged, component)

    merged = cv2.morphologyEx(merged, cv2.MORPH_CLOSE, np.ones((17, 17), np.uint8))
    return cv2.dilate(merged, np.ones((5, 5), np.uint8))


def segment_frames(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Gera uma mascara por frame. Usa IA + movimento quando possivel."""
    use_ai = _try_load_rembg()
    masks = []
    for i, f in enumerate(frames):
        if use_ai:
            try:
                person = segment_with_rembg(f)
                motion = segment_with_motion(frames, i)
                masks.append(_merge_person_and_motion(person, motion))
                continue
            except Exception as e:
                print(f"[segmentation] falha no frame {i}, usando fallback: {e}")
        masks.append(segment_with_motion(frames, i))

    # suaviza no tempo pra reduzir flicker entre frames
    smoothed = []
    n = len(masks)
    for i in range(n):
        lo, hi = max(0, i - 1), min(n, i + 2)
        stack = np.stack(masks[lo:hi]).astype(np.float32)
        avg = stack.mean(axis=0)
        smoothed.append((avg > 100).astype(np.uint8) * 255)
    return smoothed

import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { loadPhoto } from '../store/photoIDB'
import PhotoCropModal from './PhotoCropModal'

/**
 * PhotoPanel — Step 17 partial-completion #2 (Gap 1) of Kickoff Spec
 * §3 (right drawer) and §15 (re-crop / replace / clear photo controls).
 *
 * Hosts photo-as-an-object actions for the 4th drawer tab:
 *   - Re-crop (gated on hasSourcePhoto — needs the original)
 *   - Replace photo (file picker → crop modal — same pipeline as the
 *                   📷 toolbar button, surfaced here for discoverability)
 *   - Clear photo (wipes both IDB slots + in-memory backgroundImage —
 *                  same as the ✕ toolbar button)
 *
 * Promotes "the photo" to first-class drawer status. Previously these
 * controls were split across:
 *   - PropertiesPanel: Re-crop buried at the bottom of layer properties
 *   - Canvas toolbar:  📷 (replace) and ✕ (clear) buttons
 * Operators on a short viewport scrolled past Re-crop without seeing it,
 * and the toolbar buttons read as "drawing tools" not "manage the photo."
 *
 * Failure-mode hardening (per Gap 1 investigation):
 *   - Re-crop: if loadPhoto('source') returns null, alert and bail
 *     instead of silent no-op (photo can desync from IDB if the operator
 *     wiped IDB via DevTools, or via a corrupted prior session).
 *   - Replace: if FileReader fails, alert.
 *
 * Tab is conditionally rendered in App.jsx when photoMeta is truthy.
 * If photoMeta clears (operator hits Clear photo while on this tab) the
 * tab disappears and effectiveDrawerTab in App.jsx falls back to
 * 'properties' (same pattern as Annotations).
 */
export default function PhotoPanel() {
  const photoMeta = useAppStore((s) => s.photoMeta)
  const cropMeta = useAppStore((s) => s.cropMeta)
  const hasSourcePhoto = useAppStore((s) => s.hasSourcePhoto)
  const clearBackgroundImage = useAppStore((s) => s.clearBackgroundImage)

  // Two crop-modal mounts: one for re-crop (initialCrop preloaded so
  // the operator picks up where they left off), one for replace (fresh
  // crop, no initial). Same pattern as DrawingTools / pre-Gap-1
  // PropertiesPanel.
  const [recropSrc, setRecropSrc] = useState(null)
  const [pendingSource, setPendingSource] = useState(null)
  const fileInputRef = useRef(null)

  const onRecropClick = async () => {
    const src = await loadPhoto('source').catch(() => null)
    if (typeof src !== 'string' || src.length === 0) {
      // Failure-mode hardening (Gap 1 investigation finding 4):
      // photoMeta + hasSourcePhoto can claim the source exists when
      // IDB has been wiped underneath us. Surface the discrepancy
      // instead of opening an empty modal.
      window.alert('Photo not available — re-upload via 📷 to enable re-crop.')
      return
    }
    setRecropSrc(src)
  }
  // Shared confirm path for both re-crop and replace. Step 17 partial #2
  // (Gap 2): commitCroppedPhoto backs up the previous photo to _undo
  // slots before writing the new one — Cmd+Z reverses re-crop / replace.
  // Step 17 partial #4 (Bug C): commitCroppedPhoto returns boolean. On
  // false (operator cancelled the out-of-bounds confirm dialog), keep
  // the crop modal open so the operator can adjust the rect. On true,
  // close the modal. The two flows pass different `isRecrop` values:
  //   - Re-crop path (sourceDataURL came from IDB): isRecrop=true →
  //     triggers shape re-projection in the store.
  //   - Replace path (sourceDataURL is a fresh file pick): isRecrop=
  //     false → no re-projection (the source photo is brand new; old
  //     shape coords remain at their fractional positions in the new
  //     photo's frame).
  const commitCrop = async (payload, { isRecrop }) => {
    try {
      const committed = await useAppStore.getState().commitCroppedPhoto({
        ...payload,
        isRecrop,
      })
      if (committed) {
        setRecropSrc(null)
        setPendingSource(null)
      }
      // committed === false → operator cancelled; modal stays open.
    } catch (err) {
      const msg = err?.message || String(err)
      console.warn('Photo commit failed:', msg)
      setRecropSrc(null)
      setPendingSource(null)
      window.alert(`Could not apply photo: ${msg}`)
    }
  }
  const onRecropConfirm = (payload) => commitCrop(payload, { isRecrop: true })
  const onReplaceConfirm = (payload) => commitCrop(payload, { isRecrop: false })

  const onPickReplace = () => fileInputRef.current?.click()
  const onReplaceFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again later
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataURL = ev.target?.result
      if (typeof dataURL !== 'string') {
        window.alert('Could not read the selected file as an image.')
        return
      }
      setPendingSource({ dataURL })
    }
    reader.onerror = () => window.alert('Could not read the selected file.')
    reader.readAsDataURL(file)
  }

  // Step 17 partial #2 (Gap 2): clearBackgroundImage is now async and
  // backs up the current photo to _undo slots before wiping live IDB —
  // Cmd+Z restores the photo. Awaiting isn't strictly required (the
  // store flips visible state on the way through) but we await to keep
  // any chained UI consistent on completion.
  const onClear = async () => {
    const ok = window.confirm(
      'Clear the background photo? Your shapes, sequences, and annotations stay. Cmd+Z reverses this.'
    )
    if (!ok) return
    await clearBackgroundImage()
  }

  return (
    <>
      <div className="panel-header">Photo</div>
      <div className="panel-body photo-panel-body">
        {photoMeta ? (
          <section className="props-section" aria-label="Photo summary">
            <div className="props-section-title">Current</div>
            <div className="prop-row">
              <span className="prop-label">Size</span>
              <span className="prop-value">{photoMeta.width} × {photoMeta.height} px</span>
            </div>
            {cropMeta && (
              <div className="prop-row">
                <span className="prop-label">Source crop</span>
                <span className="prop-value">
                  {cropMeta.w}×{cropMeta.h}
                </span>
              </div>
            )}
          </section>
        ) : (
          <div className="panel-empty">No photo loaded.</div>
        )}
        <section className="props-section" aria-label="Photo actions">
          <div className="props-section-title">Actions</div>
          <button
            type="button"
            className="btn-panel-action btn-add"
            onClick={onRecropClick}
            disabled={!hasSourcePhoto}
            title={hasSourcePhoto
              ? 'Open the crop modal with the original source photo'
              : 'Re-crop requires the original source photo. Re-upload via Replace photo to enable.'}
            data-testid="btn-recrop-photo"
          >
            Re-crop photo
          </button>
          <button
            type="button"
            className="btn-panel-action"
            onClick={onPickReplace}
            title="Pick a new image file. Replaces the current photo on confirm."
            data-testid="btn-replace-photo"
          >
            Replace photo…
          </button>
          <button
            type="button"
            className="btn-panel-action btn-clear"
            onClick={onClear}
            disabled={!photoMeta}
            title={photoMeta
              ? 'Clear the background photo. Shapes / sequences / annotations stay.'
              : 'No photo loaded.'}
            data-testid="btn-clear-photo"
          >
            Clear photo
          </button>
        </section>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onReplaceFile}
        style={{ display: 'none' }}
        data-testid="photo-replace-file-input"
      />
      {recropSrc && (
        <PhotoCropModal
          sourceDataURL={recropSrc}
          initialCrop={cropMeta}
          onConfirm={onRecropConfirm}
          onCancel={() => setRecropSrc(null)}
        />
      )}
      {pendingSource && (
        <PhotoCropModal
          sourceDataURL={pendingSource.dataURL}
          onConfirm={onReplaceConfirm}
          onCancel={() => setPendingSource(null)}
        />
      )}
    </>
  )
}

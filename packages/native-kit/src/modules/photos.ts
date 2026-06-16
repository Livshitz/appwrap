import type { NativeKit } from '../core/NativeKit';

export interface PickPhotoOptions {
  /** Return the image as a downscaled JPEG data URL the PWA can render/upload. */
  dataUrl?: boolean;
  /** Longest-edge cap in px for the returned dataUrl (default 1024). */
  maxSize?: number;
}

export interface PickedPhoto {
  picked: boolean;
  /** Present when picked: dimensions of the selected image. */
  width?: number;
  height?: number;
  /** Present when `dataUrl` was requested: `data:image/jpeg;base64,...`. */
  dataUrl?: string;
}

export class PhotosModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('photos');
  }

  get cameraCapability() {
    return this.kit.capability('camera');
  }

  /** Open the system photo picker; resolves { picked: false } when dismissed. */
  pick(options?: PickPhotoOptions): Promise<PickedPhoto> {
    return this.kit.invoke('photos.pick', options, { timeoutMs: 120_000 });
  }

  /** Capture a photo with the camera. UNSUPPORTED where no camera exists (e.g. simulator). */
  capture(options?: PickPhotoOptions): Promise<PickedPhoto> {
    return this.kit.invoke('camera.capture', options, { timeoutMs: 120_000 });
  }
}

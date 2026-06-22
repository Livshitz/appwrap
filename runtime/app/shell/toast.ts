import { Utils, isAndroid, isIOS } from '@nativescript/core';

/** Native toast (trimmed to what the kit exposes). */
export function showToast(message: string, duration: 'short' | 'long' = 'short'): void {
  const ms = duration === 'long' ? 3500 : 2000;
  if (isAndroid) {
    const Toast = android.widget.Toast;
    Toast.makeText(
      Utils.android.getApplicationContext(),
      message,
      duration === 'long' ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT
    ).show();
  } else if (isIOS) {
    showIOSToast(message, ms);
  }
}

function showIOSToast(message: string, durationMs: number): void {
  const rootVC = Utils.ios.getRootViewController();
  if (!rootVC?.view) return;

  const containerView = UIView.alloc().initWithFrame(CGRectMake(0, 0, 300, 60));
  containerView.backgroundColor = UIColor.colorWithRedGreenBlueAlpha(0.08, 0.08, 0.1, 0.6);
  containerView.layer.cornerRadius = 12;
  containerView.clipsToBounds = true;

  const blurEffect = UIBlurEffect.effectWithStyle(UIBlurEffectStyle.Dark);
  const blurView = UIVisualEffectView.alloc().initWithEffect(blurEffect);
  blurView.frame = containerView.bounds;
  blurView.autoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
  containerView.addSubview(blurView);

  const label = UILabel.alloc().initWithFrame(CGRectMake(16, 0, 268, 60));
  label.text = message;
  label.textColor = UIColor.whiteColor;
  label.textAlignment = NSTextAlignment.Center;
  label.font = UIFont.systemFontOfSizeWeight(15, UIFontWeightMedium);
  label.numberOfLines = 2;
  blurView.contentView.addSubview(label);

  const screenBounds = UIScreen.mainScreen.bounds;
  containerView.center = CGPointMake(screenBounds.size.width / 2, screenBounds.size.height - 120);

  rootVC.view.addSubview(containerView);
  containerView.alpha = 0;
  containerView.transform = CGAffineTransformMakeScale(0.8, 0.8);

  UIView.animateWithDurationDelayOptionsAnimationsCompletion(
    0.3, 0, UIViewAnimationOptions.CurveEaseOut,
    () => {
      containerView.alpha = 1;
      containerView.transform = CGAffineTransformIdentity;
    },
    () => {
      setTimeout(() => {
        UIView.animateWithDurationDelayOptionsAnimationsCompletion(
          0.3, 0, UIViewAnimationOptions.CurveEaseIn,
          () => {
            containerView.alpha = 0;
            containerView.transform = CGAffineTransformMakeScale(0.8, 0.8);
          },
          () => containerView.removeFromSuperview()
        );
      }, durationMs);
    }
  );
}

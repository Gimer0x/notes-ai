#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns the NSException AVAudioEngine raises. Swift cannot catch those.
NSException *_Nullable PithCatchException(NS_NOESCAPE void (^block)(void));

NS_ASSUME_NONNULL_END

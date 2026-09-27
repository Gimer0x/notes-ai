#import "ExceptionCatcher.h"

NSException *_Nullable PithCatchException(void (^block)(void)) {
  @try {
    block();
    return nil;
  } @catch (NSException *exception) {
    return exception;
  }
}

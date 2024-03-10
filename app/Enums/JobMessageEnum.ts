export enum JobMessageEnum {
  FAILED = -1,
  DISPATCHED = 0,
  RUNNING = 1,
  COMPLETED = 2,
  LOGGING = 3,
  MESSAGE = 4,
  PROGRESS_BAR_ON = 5,
  PROGRESS_BAR_UPDATE = 6,
  PROGRESS_BAR_OFF = 7,
  PROGRESS_BAR_OFF_ALL = 8,
  CONSOLE_LOG = 9,
  PROGRESS_BAR_CHANGE_TITLE = 10,
  PROGRESS_BAR_SET_PROGRESS = 11,
  PROGRESS_BAR_ON_INDEX = 12,
  SOCKET_EMIT = 14,
  STOPPED = 15,
}

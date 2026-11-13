class AppError(Exception):
    """The only kind of error whose message is ever shown to a person in the browser."""

    def __init__(self, message: str, status: int = 400, code: str | None = None,
                 retry_after: float | None = None, show_code: bool = False):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code                # a short machine-readable reason (for example "no_text")
        self.retry_after = retry_after  # seconds until it is worth trying again
        self.show_code = show_code      # only the file reader sends `code` to the page

"""One error type for everything that goes wrong while generating (gateway unreachable, task failed, bad input)."""


class GenError(Exception):
    pass

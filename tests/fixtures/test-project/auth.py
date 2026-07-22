import os
import sys
import os as operating_system
from typing import Optional

__all__ = ['Authenticator', 'login_required']

MAX_ATTEMPTS = 3

def login_required(func):
    '''Decorates a view function to require authentication.'''
    def wrapper(*args, **kwargs):
        'A wrapper function.'
        return func(*args, **kwargs)
    return wrapper

class Authenticator:
    """Handles user authentication by verifying credentials and managing access control."""
    secret_key = "default"

    def __init__(self):
        """Initialize a new authenticator object."""
        self.attempts = 0

    @login_required
    def authenticate(self, username, password):
        """Authenticates a user by verifying their username and password."""
        if not os.environ.get("AUTH_SECRET"):
            raise ValueError("AUTH_SECRET not set")
        if username == "admin" and password == "secret":
            return True
        raise ValueError("Invalid credentials")


def require_role(role):
    '''Decorator factory - exercises a decorator applied with call syntax.'''
    def decorator(func):
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        return wrapper
    return decorator


class WrapValue:
    def __init__(self, v):
        self.v = v

    def double(self):
        return self.v * 2


def wrap_value(v):
    return WrapValue(v)


# Exercises callee_base default-value (`or`) stripping in PythonCallSiteResolver.
def use_fallback(a=None):
    return wrap_value(a or 5).double()


# Exercises super().method() calls.
class AdminAuthenticator(Authenticator):
    def __init__(self):
        super().__init__()
        self.role = 'admin'

    @require_role('admin')
    def admin_only(self):
        return True

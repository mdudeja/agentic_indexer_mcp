from .auth import Authenticator
from .auth import login_required as require_login

if __name__ == "__main__":
    auth = Authenticator()
    try:
        if auth.authenticate("admin", "secret"):
            print("Authentication successful")
    except ValueError as e:
        print(f"Authentication failed: {e}")

handlers = {'run': lambda: print('run')}


# Exercises a dynamic subscript call with a literal string key.
def invoke_dynamic():
    handlers['run']()


# Exercises a getattr(...)()-style dynamic call.
def invoke_via_getattr(obj):
    return getattr(obj, 'run')()

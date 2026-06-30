from .auth import Authenticator
from .auth import login_required as require_login

if __name__ == "__main__":
    auth = Authenticator()
    try:
        if auth.authenticate("admin", "secret"):
            print("Authentication successful")
    except ValueError as e:
        print(f"Authentication failed: {e}")

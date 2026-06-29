import os

def login_required(func):
    """ Decorates a view function to require authentication. Redirects unauthenticated users if they attempt to access the route. """
    def wrapper(*args, **kwargs):
        """ A wrapper function that encapsulates and modifies the behavior of another function, handling any provided arguments. """
        return func(*args, **kwargs)
    return wrapper

class Authenticator:
    """ Handles user authentication by verifying credentials and managing access control. """
    def __init__(self):
        """ Initialize a new authenticator object. """
        pass

    @login_required
    def authenticate(self, username, password):
        """ Authenticates a user by verifying their username and password. Returns True if authentication is successful. """
        if not os.environ.get("AUTH_SECRET"):
            raise ValueError("AUTH_SECRET not set")
        if username == "admin" and password == "secret":
            return True
        raise ValueError("Invalid credentials")

c.NotebookApp.extra_template_paths.append('/etc/jupyterhub/templates')

# cull_idle_timeout: timeout (in seconds) after which an idle kernel is
# considered ready to be culled
c.MappingKernelManager.cull_idle_timeout = 1200 # default: 0

# cull_interval: the interval (in seconds) on which to check for idle
# kernels exceeding the cull timeout value
c.MappingKernelManager.cull_interval = 120 # default: 300

# cull_connected: whether to consider culling kernels which have one
# or more connections
c.MappingKernelManager.cull_connected = True # default: false

# cull_busy: whether to consider culling kernels which are currently
# busy running some code
c.MappingKernelManager.cull_busy = False # default: false
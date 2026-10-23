"""Optional, pinned pretrained material pilot; never an automatic/default model.

Importing this module does not download, import Torch, or execute upstream code.
"""

from .contract import PilotRequest, export_material_bundle

__all__ = ["PilotRequest", "export_material_bundle"]

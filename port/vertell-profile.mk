define Device/vertell_vt-mt7621d
  $(Device/nand)
  DEVICE_VENDOR := Vertell
  DEVICE_MODEL := VT-STREET-M2
  IMAGE_SIZE := 121344k
  DEVICE_PACKAGES := -uboot-envtools \
	kmod-usb3 kmod-usb-acm kmod-usb-net-cdc-ncm \
	kmod-usb-net-qmi-wwan kmod-usb-serial-option uqmi
endef
TARGET_DEVICES += vertell_vt-mt7621d

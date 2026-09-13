include $(TOPDIR)/rules.mk

PKG_NAME:=vtmodem
PKG_RELEASE:=14

include $(INCLUDE_DIR)/package.mk

define Package/vtmodem
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=VT-STREET-M2 modem backend and LuCI interface
  DEPENDS:=+flock +jsonfilter +luci-base +rpcd +qmi-utils +kmod-usb-acm +kmod-usb-net-cdc-ncm +kmod-usb-net-qmi-wwan +kmod-usb-serial-option
endef

define Package/vtmodem/description
  Vendor-independent modem backend for VT-STREET-M2.
  Supports Fibocom L860-GL-16 and Dell/Foxconn T99W175 detection,
  modem telemetry, T99 USB binding, QMI networking and SMS PDU operations.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/vt-at.c $(PKG_BUILD_DIR)/
	$(CP) ./src/vt-sms.c $(PKG_BUILD_DIR)/
	patch -d $(PKG_BUILD_DIR) -p0 < ./patches/010-vt-sms-segmentation-and-alpha-sender.patch
	patch -d $(PKG_BUILD_DIR) -p0 < ./patches/020-vt-sms-shared-flock.patch
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -Wall -Wextra \
		-o $(PKG_BUILD_DIR)/vt-at $(PKG_BUILD_DIR)/vt-at.c
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -Wall -Wextra \
		-o $(PKG_BUILD_DIR)/vt-sms $(PKG_BUILD_DIR)/vt-sms.c
endef

define Package/vtmodem/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/vt-at $(1)/usr/bin/vt-at.real
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/vt-sms $(1)/usr/bin/vt-sms.real
	$(INSTALL_BIN) ./files/usr/bin/vt-at-locked $(1)/usr/bin/vt-at
	$(INSTALL_BIN) ./files/usr/bin/vt-sms-locked $(1)/usr/bin/vt-sms

	$(INSTALL_DIR) $(1)/etc/hotplug.d/usb
	$(INSTALL_BIN) ./files/etc/hotplug.d/usb/03_t99w175 \
		$(1)/etc/hotplug.d/usb/03_t99w175

	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) ./files/usr/libexec/t99w175-net-ready \
		$(1)/usr/libexec/t99w175-net-ready

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/vtmodem-startup \
		$(1)/etc/init.d/vtmodem-startup

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/20-vt-mac \
		$(1)/etc/uci-defaults/20-vt-mac

	$(INSTALL_DIR) $(1)/lib/netifd/proto
	$(INSTALL_BIN) ./files/lib/netifd/proto/t99w175qmi.sh \
		$(1)/lib/netifd/proto/t99w175qmi.sh

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./files/usr/share/rpcd/ucode/vtmodem $(1)/usr/share/rpcd/ucode/vtmodem

	$(INSTALL_DIR) $(1)/usr/share/vtmodem
	$(INSTALL_DATA) ./files/usr/share/vtmodem/qmi.uc $(1)/usr/share/vtmodem/qmi.uc
	$(INSTALL_DATA) ./files/usr/share/vtmodem/qmi-status.uc $(1)/usr/share/vtmodem/qmi-status.uc
	$(INSTALL_DATA) ./files/usr/share/vtmodem/t99-radio.uc $(1)/usr/share/vtmodem/t99-radio.uc

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-vtmodem.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-vtmodem.json

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-vtmodem.json \
		$(1)/usr/share/luci/menu.d/luci-app-vtmodem.json

	$(INSTALL_DIR) $(1)/www/luci-static/resources/protocol
	$(INSTALL_DATA) ./files/www/luci-static/resources/protocol/t99w175qmi.js \
		$(1)/www/luci-static/resources/protocol/t99w175qmi.js

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/vtmodem
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/vtmodem/status.js \
		$(1)/www/luci-static/resources/view/vtmodem/status.js
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/vtmodem/sms.js \
		$(1)/www/luci-static/resources/view/vtmodem/sms.js
endef

$(eval $(call BuildPackage,vtmodem))

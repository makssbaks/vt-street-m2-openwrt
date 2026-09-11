include $(TOPDIR)/rules.mk

PKG_NAME:=vtmodem
PKG_RELEASE:=4

include $(INCLUDE_DIR)/package.mk

define Package/vtmodem
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=VT-STREET-M2 modem backend and LuCI interface
  DEPENDS:=+luci-base +rpcd
endef

define Package/vtmodem/description
  Vendor-independent modem backend for VT-STREET-M2.
  Supports Fibocom L860-GL-16 and Dell/Foxconn T99W175 detection,
  modem telemetry and T99 SMS PDU operations.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/vt-at.c $(PKG_BUILD_DIR)/
	$(CP) ./src/vt-sms.c $(PKG_BUILD_DIR)/
	patch -d $(PKG_BUILD_DIR) -p0 < ./patches/010-vt-sms-segmentation-and-alpha-sender.patch
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -Wall -Wextra \
		-o $(PKG_BUILD_DIR)/vt-at $(PKG_BUILD_DIR)/vt-at.c
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -Wall -Wextra \
		-o $(PKG_BUILD_DIR)/vt-sms $(PKG_BUILD_DIR)/vt-sms.c
endef

define Package/vtmodem/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/vt-at $(1)/usr/bin/vt-at
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/vt-sms $(1)/usr/bin/vt-sms

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./files/usr/share/rpcd/ucode/vtmodem $(1)/usr/share/rpcd/ucode/vtmodem

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-vtmodem.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-vtmodem.json

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-vtmodem.json \
		$(1)/usr/share/luci/menu.d/luci-app-vtmodem.json

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/vtmodem
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/vtmodem/status.js \
		$(1)/www/luci-static/resources/view/vtmodem/status.js
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/vtmodem/sms.js \
		$(1)/www/luci-static/resources/view/vtmodem/sms.js
endef

$(eval $(call BuildPackage,vtmodem))

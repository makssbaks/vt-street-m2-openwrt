include $(TOPDIR)/rules.mk

PKG_NAME:=vtmodem
PKG_RELEASE:=3

include $(INCLUDE_DIR)/package.mk

define Package/vtmodem
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=VT-STREET-M2 modem backend and LuCI status page
  DEPENDS:=+luci-base +rpcd
endef

define Package/vtmodem/description
  Minimal vendor-independent modem status backend for VT-STREET-M2.
  Initial implementation supports Fibocom L860-GL-16 on ttyACM0/wwan0.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/vt-at.c $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -Wall -Wextra \
		-o $(PKG_BUILD_DIR)/vt-at $(PKG_BUILD_DIR)/vt-at.c
endef

define Package/vtmodem/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/vt-at $(1)/usr/bin/vt-at

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
endef

$(eval $(call BuildPackage,vtmodem))

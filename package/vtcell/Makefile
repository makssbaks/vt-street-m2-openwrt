include $(TOPDIR)/rules.mk
PKG_NAME:=luci-app-vtcell
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=ISC
PKGARCH:=all
include $(INCLUDE_DIR)/package.mk
define Package/luci-app-vtcell
  SECTION:=luci
  CATEGORY:=LuCI
  TITLE:=Cell signal dashboard for ModemManager
  DEPENDS:=+luci-base +modemmanager +ucode +ucode-mod-fs +rpcd-mod-ucode +flock
endef
define Build/Compile
endef
define Package/luci-app-vtcell/install
	$(CP) ./files/* $(1)/
	chmod 755 $(1)/etc/init.d/vtcell $(1)/usr/libexec/vtcell-collector
	$(INSTALL_DIR) $(1)/usr/share/licenses/luci-app-vtcell
	$(INSTALL_DATA) ./LICENSE $(1)/usr/share/licenses/luci-app-vtcell/LICENSE
endef
$(eval $(call BuildPackage,luci-app-vtcell))

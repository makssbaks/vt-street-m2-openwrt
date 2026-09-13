'use strict';
'require form';
'require network';

network.registerPatternVirtual(/^t99w175qmi-.+$/);

return network.registerProtocol('t99w175qmi', {
	getI18n: function() {
		return _('T99W175 QMI');
	},

	getIfname: function() {
		return this._ubus('l3_device') || 't99w175qmi-%s'.format(this.sid);
	},

	getPackageName: function() {
		return 'vtmodem';
	},

	isFloating: function() {
		return true;
	},

	isVirtual: function() {
		return true;
	},

	getDevices: function() {
		return null;
	},

	containsDevice: function(ifname) {
		return network.getIfnameOf(ifname) == this.getIfname();
	},

	renderFormOptions: function(s) {
		var o;

		o = s.taboption('general', form.Value, 'apn', _('APN'));
		o.placeholder = 'internet';
		o.validate = function(section_id, value) {
			return !value || /^[a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(value)
				? true : _('Invalid APN provided');
		};

		o = s.taboption('general', form.ListValue, 'auth', _('Authentication Type'));
		o.value('none', _('None'));
		o.value('pap', 'PAP');
		o.value('chap', 'CHAP');
		o.default = 'none';

		var validateCredential = function(section_id, value) {
			return !value || !/[,\r\n]/.test(value)
				? true : _('Commas and line breaks are not supported');
		};

		o = s.taboption('general', form.Value, 'username', _('PAP/CHAP username'));
		o.depends('auth', 'pap');
		o.depends('auth', 'chap');
		o.validate = validateCredential;

		o = s.taboption('general', form.Value, 'password', _('PAP/CHAP password'));
		o.depends('auth', 'pap');
		o.depends('auth', 'chap');
		o.password = true;
		o.validate = validateCredential;

		o = s.taboption('advanced', form.Value, 'delay', _('Modem initialization delay (seconds)'));
		o.placeholder = '0';
		o.datatype = 'uinteger';

		o = s.taboption('advanced', form.Value, 'registration_timeout', _('Network registration timeout (seconds)'));
		o.placeholder = '60';
		o.datatype = 'and(uinteger,min(1))';

		o = s.taboption('advanced', form.Flag, 'defaultroute', _('Use default gateway'));
		o.default = o.enabled;

		o = s.taboption('advanced', form.Flag, 'peerdns', _('Use DNS servers advertised by peer'));
		o.default = o.enabled;
	}
});
